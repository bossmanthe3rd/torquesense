import os
import asyncio
import tempfile
import json
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer
import warnings
warnings.filterwarnings("ignore", category=FutureWarning)
import google.generativeai as genai
from dotenv import load_dotenv
import logging

load_dotenv()

# --- LOGGING SETUP ---
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# --- CONFIGURATION ---
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set. Copy .env.example to .env and fill in the value.")
genai.configure(api_key=GEMINI_API_KEY)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_AUTH = (
    os.getenv("NEO4J_AUTH_USER", ""),
    os.getenv("NEO4J_AUTH_PASS", ""),
)

MAX_IMAGE_BYTES = 10 * 1024 * 1024   # 10 MB
MAX_AUDIO_BYTES = 25 * 1024 * 1024   # 25 MB
GEMINI_TIMEOUT = 90.0                  # seconds per Gemini API call

app = FastAPI(title="TorqueSense AI Core")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logger.info("Loading semantic embedding model (all-MiniLM-L6-v2)...")
# Dedicated semantic similarity model — 384 dims, no token-limit issues.
# Replaces CLIP which was a vision model with a 77-token cap, causing all
# text queries to collapse to the same embedding ('Renault Kwid Drive Belt').
text_model = SentenceTransformer('all-MiniLM-L6-v2')

# Module-level driver — long-lived and connection-pooled.
# Avoids the overhead of creating a new TCP connection on every request.
_driver = GraphDatabase.driver(NEO4J_URI, auth=NEO4J_AUTH)

# Load the known car names once at startup so we can do exact car detection.
try:
    with open("data/manuals.json", "r") as _f:
        _manuals = json.load(_f)
    KNOWN_CARS: list[str] = sorted(
        {item["car"] for item in _manuals if item.get("car")},
        key=lambda c: -len(c)   # longest name first — "Maruti Suzuki Brezza" before "Maruti"
    )
except Exception:
    KNOWN_CARS = []
logger.info(f"Loaded {len(KNOWN_CARS)} known car models for RAG matching.")


def extract_car_from_text(user_text: str) -> Optional[str]:
    """
    Returns the best-matching known car name using distinctive-word scoring.

    Each word is weighted by 1 / (number of cars that contain it), so a unique
    model word like "Camry" or "Wrangler" scores 1.0 while a shared brand word
    like "Toyota" or "Hyundai" scores ~0.3–0.5. Threshold 0.75 accepts a single
    distinctive model word but rejects brand-only matches ("Toyota" alone won't
    pick between Camry and Corolla).
    """
    user_lower = user_text.lower()

    # Count how many known cars contain each word
    word_car_count: dict[str, int] = {}
    for car in KNOWN_CARS:
        for w in car.lower().split():
            if len(w) >= 3:
                word_car_count[w] = word_car_count.get(w, 0) + 1

    best_car, best_score = None, 0.0
    for car in KNOWN_CARS:
        words = [w for w in car.lower().split() if len(w) >= 3]
        score = sum(
            1.0 / word_car_count.get(w, 1)
            for w in words
            if w in user_lower
        )
        if score > best_score:
            best_score = score
            best_car = car

    # 0.75 ≈ one unique model word; rejects brand-only matches
    return best_car if best_score >= 0.75 else None


def search_neo4j(search_vector, detected_car: Optional[str] = None, user_text: str = ""):
    if detected_car:
        # Car-specific path: fetch a larger candidate pool from the vector index,
        # but restrict results to only the detected car's nodes in Cypher.
        # This guarantees 'Camry' can never lose to 'Corolla' in the results.
        car_query = """
        CALL db.index.vector.queryNodes('component_embeddings', 20, $embedding)
        YIELD node AS comp, score
        MATCH (car:Car)-[:HAS_COMPONENT]->(comp)-[:HAS_REPAIR_MANUAL]->(man:Manual)
        WHERE car.name = $car_name
        RETURN car.name AS car, comp.name AS component, man.text AS manual,
               score, comp.image_url AS image_url
        ORDER BY score DESC
        LIMIT 1
        """
        with _driver.session() as session:
            records = session.run(
                car_query, embedding=search_vector, car_name=detected_car
            ).data()

        if records:
            rec = records[0]
            return {
                "car": rec["car"],
                "component": rec["component"],
                "manual": rec["manual"],
                "score": rec["score"],
                "image_url": rec["image_url"],
                "detected_car": detected_car,
            }
        # Car detected but not in DB — fall through to generic search

    # Generic path: fetch top 5, then re-rank by a car-mention boost so that
    # even partial car-name matches (brand word, partial name) are preferred.
    generic_query = """
    CALL db.index.vector.queryNodes('component_embeddings', 5, $embedding)
    YIELD node AS comp, score
    MATCH (car:Car)-[:HAS_COMPONENT]->(comp)-[:HAS_REPAIR_MANUAL]->(man:Manual)
    RETURN car.name AS car, comp.name AS component, man.text AS manual,
           score, comp.image_url AS image_url
    """
    with _driver.session() as session:
        records = session.run(generic_query, embedding=search_vector).data()

    if not records:
        return None

    # Boost records whose car name shares words with the user's text
    if user_text:
        user_lower = user_text.lower()
        for rec in records:
            car_words = [w.lower() for w in rec["car"].split() if len(w) >= 3]
            boost = 1.2 if any(w in user_lower for w in car_words) else 1.0
            rec["_rank"] = rec["score"] * boost
        records.sort(key=lambda r: r["_rank"], reverse=True)

    rec = records[0]
    return {
        "car": rec["car"],
        "component": rec["component"],
        "manual": rec["manual"],
        "score": rec["score"],
        "image_url": rec["image_url"],
        "detected_car": detected_car,  # preserve original detected car (may be None)
    }


def get_graph_data_from_db(component_name: Optional[str] = None, car_name: Optional[str] = None):
    """Return the subgraph relevant to a component and optionally restricted to a specific car."""
    if component_name and car_name:
        # Show the full subgraph for this car — all its components and manuals.
        # This gives a richer graph view that reflects the entire detected car context,
        # not just the single matched component.
        query = """
        MATCH (car:Car {name: $car_name})-[r1:HAS_COMPONENT]->(comp:Component)
        OPTIONAL MATCH (comp)-[r2:HAS_REPAIR_MANUAL]->(man:Manual)
        RETURN car, r1, comp, r2, man
        """
    elif component_name:
        query = """
        MATCH (comp) WHERE comp.name = $component OR comp.issue = $component
        MATCH (n)-[r]-(m) WHERE n = comp OR m = comp
        RETURN n, r, m
        """
    else:
        query = "MATCH (n)-[r]->(m) RETURN n, r, m"

    nodes, links = [], []
    node_ids = set()

    try:
        with _driver.session() as session:
            if component_name and car_name:
                result = session.run(query, car_name=car_name, component=component_name)
                for record in result:
                    car_node = record["car"]
                    comp_node = record["comp"]
                    r1 = record["r1"]
                    man_node = record["man"]
                    r2 = record["r2"]

                    for node in [car_node, comp_node, man_node]:
                        if node is None:
                            continue
                        if node.element_id not in node_ids:
                            label = list(node.labels)[0] if node.labels else "Unknown"
                            name = node.get("name") or node.get("issue") or "Unknown"
                            nodes.append({"id": node.element_id, "label": label, "name": name})
                            node_ids.add(node.element_id)

                    for rel in [r1, r2]:
                        if rel is None:
                            continue
                        links.append({
                            "source": rel.start_node.element_id,
                            "target": rel.end_node.element_id,
                            "label": rel.type
                        })
            else:
                result = session.run(query, component=component_name)
                for record in result:
                    n, m, r = record["n"], record["m"], record["r"]

                    if n.element_id not in node_ids:
                        label = list(n.labels)[0] if n.labels else "Unknown"
                        name = n.get("name") or n.get("issue") or "Unknown"
                        nodes.append({"id": n.element_id, "label": label, "name": name})
                        node_ids.add(n.element_id)

                    if m.element_id not in node_ids:
                        label = list(m.labels)[0] if m.labels else "Unknown"
                        name = m.get("name") or m.get("issue") or "Unknown"
                        nodes.append({"id": m.element_id, "label": label, "name": name})
                        node_ids.add(m.element_id)

                    links.append({
                        "source": n.element_id,
                        "target": m.element_id,
                        "label": r.type
                    })
        return {"nodes": nodes, "links": links}
    except Exception as e:
        return {"error": str(e)}


async def describe_image_for_search(image_bytes: bytes, image_extension: str):
    """
    Upload the image to Gemini once and return:
      - A searchable text description of the car part / symptom (for vector search)
      - The Gemini file object (reused in the main diagnostic prompt — no second upload)
    """
    loop = asyncio.get_running_loop()

    with tempfile.NamedTemporaryFile(delete=False, suffix=image_extension) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name

    try:
        gemini_file = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: genai.upload_file(path=tmp_path)),
            timeout=GEMINI_TIMEOUT,
        )
    finally:
        os.remove(tmp_path)

    vision_model = genai.GenerativeModel('gemini-flash-latest')
    prompt = [
        "You are an automotive diagnostic assistant. Examine this image carefully and describe:\n"
        "1. Which specific car component or part is visible?\n"
        "2. What symptoms, damage, or wear patterns are visible?\n"
        "3. Which automotive system (engine, brakes, suspension, electrical, etc.) does this belong to?\n"
        "Be concise and use precise technical automotive terminology. "
        "This description will be used to search an automotive repair manual database.",
        gemini_file
    ]
    response = await asyncio.wait_for(
        loop.run_in_executor(None, lambda: vision_model.generate_content(prompt)),
        timeout=GEMINI_TIMEOUT,
    )
    return response.text, gemini_file


async def transcribe_audio_with_gemini(audio_bytes: bytes, audio_extension: str):
    """
    Upload audio to Gemini and generate a textual description of the car sound.
    Returns (transcript_text, gemini_file_object).
    The file object is kept alive so it can be reused in the main prompt — no re-upload needed.
    """
    loop = asyncio.get_running_loop()

    with tempfile.NamedTemporaryFile(delete=False, suffix=audio_extension) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        gemini_file = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: genai.upload_file(path=tmp_path)),
            timeout=GEMINI_TIMEOUT,
        )
    finally:
        os.remove(tmp_path)

    transcription_model = genai.GenerativeModel('gemini-flash-latest')
    prompt = [
        "You are an automotive diagnostic assistant. Listen carefully to this audio recording from a car. "
        "Describe: the exact type of sound you hear (e.g., knocking, squealing, grinding, clicking, rattling, "
        "hissing, whining), which automotive component or system it most likely originates from, and what "
        "the symptom suggests about the fault. Be specific and concise — this description will be used to "
        "search an automotive repair knowledge base.",
        gemini_file
    ]
    response = await asyncio.wait_for(
        loop.run_in_executor(None, lambda: transcription_model.generate_content(prompt)),
        timeout=GEMINI_TIMEOUT,
    )
    return response.text, gemini_file


@app.get("/health")
def health_check():
    """
    Simple health check endpoint to verify database connectivity.
    """
    try:
        with _driver.session() as session:
            session.run("RETURN 1")
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Database unavailable: {str(e)}")


@app.get("/graph-data")
def get_graph_data(component: Optional[str] = None):
    """
    Retrieves knowledge graph data from Neo4j for visualization on the frontend.
    """
    return get_graph_data_from_db(component)


@app.post("/diagnose")
async def diagnose(
    image: Optional[UploadFile] = File(None),
    audio: Optional[UploadFile] = File(None),
    text_issue: Optional[str] = Form(None),
    chat_history: Optional[str] = Form("[]")
):
    """
    Main diagnostic endpoint.
    Orchestrates the multimodal inputs (image, audio, text), queries the Gemini models,
    performs semantic search on Neo4j for relevant repair manuals, and returns the response.
    """
    # Parse chat history before the main try block so malformed JSON gets a proper 400.
    try:
        history = json.loads(chat_history)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid chat_history: must be a valid JSON array.")

    try:
        loop = asyncio.get_running_loop()

        # 1. Read file bytes immediately
        image_bytes = await image.read() if image else None
        audio_bytes = await audio.read() if audio else None

        # 1a. Enforce file size limits before sending anything to Gemini.
        if image_bytes and len(image_bytes) > MAX_IMAGE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Image too large. Maximum allowed size is {MAX_IMAGE_BYTES // (1024 * 1024)} MB."
            )
        if audio_bytes and len(audio_bytes) > MAX_AUDIO_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Audio file too large. Maximum allowed size is {MAX_AUDIO_BYTES // (1024 * 1024)} MB."
            )

        # 2. Process image: upload to Gemini ONCE, get description for vector search
        #    AND keep the file object to reuse in the main prompt (no second upload).
        image_description = None
        gemini_img_file = None

        if image_bytes:
            img_ext = os.path.splitext(image.filename)[1] or ".jpg"
            logger.info(f"Processing image upload: {image.filename}")
            image_description, gemini_img_file = await describe_image_for_search(image_bytes, img_ext)

        # 3. Process audio: upload to Gemini, transcribe for vector search,
        #    keep file object for reuse in main prompt.
        audio_transcript = None
        gemini_audio_file = None

        if audio_bytes:
            aud_ext = os.path.splitext(audio.filename)[1] or ".mp3"
            logger.info(f"Processing audio upload: {audio.filename}")
            audio_transcript, gemini_audio_file = await transcribe_audio_with_gemini(audio_bytes, aud_ext)

        # 4. Database search — only runs on the first turn of a conversation
        db_context = None
        subgraph_data = None

        if len(history) == 0:
            if not image_bytes and not text_issue and not audio_transcript:
                raise HTTPException(
                    status_code=400,
                    detail="Please provide an image, audio recording, or text description to start the diagnostic."
                )

            # Detect the car from the user's own words (most reliable signal).
            # image_description is excluded here — Gemini won't mention the car
            # model unless it's clearly printed on the part, which is rare.
            car_detect_text = " ".join(filter(None, [text_issue, audio_transcript]))
            detected_car = extract_car_from_text(car_detect_text) if car_detect_text else None

            # Build a rich embedding text by combining all available context.
            # Then strip the detected car name so symptom/component semantics
            # dominate — stored vectors contain only symptoms, not car names,
            # so including the car name in the query embedding hurts similarity.
            all_context_text = " ".join(filter(None, [text_issue, audio_transcript, image_description]))
            if detected_car and all_context_text:
                car_words = set(w.lower() for w in detected_car.split())
                cleaned = [w for w in all_context_text.split() if w.lower() not in car_words]
                embed_text = " ".join(cleaned) if len(cleaned) >= 3 else all_context_text
            else:
                embed_text = all_context_text

            # Run CPU-bound embedding and blocking DB calls in a thread so the event loop stays free.
            search_vector = await loop.run_in_executor(
                None, lambda: text_model.encode(embed_text).tolist()
            )
            db_context = await loop.run_in_executor(
                None, lambda: search_neo4j(
                    search_vector,
                    detected_car=detected_car,
                    user_text=car_detect_text,
                )
            )
            if not db_context:
                raise HTTPException(status_code=404, detail="No matching component found in the database.")

            # Use db_context["car"] (the confirmed DB car) for the subgraph query.
            # detected_car may name a car not in the DB (fallthrough case); using the
            # actual matched car guarantees a non-empty subgraph is returned.
            subgraph_data = await loop.run_in_executor(
                None, lambda: get_graph_data_from_db(
                    component_name=db_context["component"],
                    car_name=db_context["car"],
                )
            )

        # 5. Build the prompt for Gemini
        prompt_parts = []

        if db_context:
            context_text = (
                f"Car: {db_context['car']}\n"
                f"Component: {db_context['component']}\n"
                f"Manual: {db_context['manual']}"
            )
            prompt_parts.extend([
                "You are TorqueSense AI, an expert automotive mechanic. ",
                "Based on our database, here is the official repair manual context for the suspected part:\n\n",
                f"{context_text}\n\n",
                "Please give the user a helpful, step-by-step diagnostic and repair response."
            ])
            # Pin Gemini to the confirmed DB car so torque specs, part numbers, and
            # procedures are accurate for the vehicle whose manual was retrieved.
            prompt_parts.append(
                f"\n\nCRITICAL: The repair manual above is for a **{db_context['car']}**. "
                f"Every torque spec, part number, procedure, and recommendation in your "
                f"response must be accurate for this exact vehicle. Do not reference or "
                f"describe repairs for any other make or model."
            )

        if text_issue:
            prompt_parts.append(f"\nUser's description: {text_issue}")

        # Include the audio transcript so Gemini has full context about what was heard,
        # even on subsequent turns where we skip the DB search.
        if audio_transcript:
            prompt_parts.append(
                f"\n[Audio Analysis — what was heard in the recording: {audio_transcript}]"
            )

        # 6. Attach media files to the Gemini prompt.
        #    Image file was already uploaded in step 2 — reuse the object, no second upload.
        #    Audio file was already uploaded in step 3 — same pattern.
        if gemini_img_file:
            prompt_parts.append(gemini_img_file)

        if gemini_audio_file:
            prompt_parts.append(gemini_audio_file)

        # 7. Generate the response — run in executor to avoid blocking the event loop.
        gemini_model = genai.GenerativeModel('gemini-flash-latest')
        chat = gemini_model.start_chat(history=history)
        response = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: chat.send_message(prompt_parts)),
            timeout=GEMINI_TIMEOUT,
        )

        return {
            "identified_part": db_context["component"] if db_context else "Continuing Conversation",
            "confidence": round(db_context["score"], 3) if db_context else None,
            "image_url": db_context.get("image_url") if db_context else None,
            "ai_response": response.text,
            "graph_data": subgraph_data
        }

    except HTTPException:
        raise
    except (asyncio.TimeoutError, TimeoutError):
        raise HTTPException(status_code=504, detail="Gemini API request timed out. Please try again.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
