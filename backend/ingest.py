import os
import json
from neo4j import GraphDatabase
from sentence_transformers import SentenceTransformer
from dotenv import load_dotenv
import logging

load_dotenv()

# --- LOGGING SETUP ---
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

logger.info("Loading semantic embedding model... (This may take a minute on the first run)")
# all-MiniLM-L6-v2 is a dedicated semantic similarity model (384 dims).
# It handles text-to-text matching far better than CLIP, which is a vision-
# language model with a 77-token limit — not designed for automotive text search.
model = SentenceTransformer('all-MiniLM-L6-v2')

URI = os.getenv("NEO4J_URI", "bolt://neo4j:7687")
AUTH = (os.getenv("NEO4J_AUTH_USER", ""), os.getenv("NEO4J_AUTH_PASS", ""))
DATA_FILE = "data/manuals.json"


def get_text_embedding(text: str):
    """Generates a 384-dimensional semantic embedding vector for the given text."""
    return model.encode(text).tolist()


def delete_all_nodes(tx):
    """Deletes all existing nodes and relationships in the Neo4j database."""
    tx.run("MATCH (n) DETACH DELETE n")


def insert_item(tx, item, vector):
    """
    Inserts a single manual entry into the Neo4j graph.
    Creates Car, Component, and Manual nodes, and sets the embedding vector on the Component.
    """
    query = """
        MERGE (car:Car {name: $car_name})
        MERGE (comp:Component {name: $comp_name})
        SET comp.embedding = $vector,
            comp.image_url = $image_url
        MERGE (man:Manual {issue: $issue})
        SET man.text = $manual_text
        MERGE (car)-[:HAS_COMPONENT]->(comp)
        MERGE (comp)-[:HAS_REPAIR_MANUAL]->(man)
    """
    tx.run(
        query,
        car_name=item.get("car", "Unknown Vehicle"),
        comp_name=item.get("component", "Unknown Part"),
        vector=vector,
        image_url=item.get("image_url", ""),
        issue=item.get("issue", "General Diagnostic"),
        manual_text=item.get("manual", "")
    )


def main():
    """Main ingestion script logic."""
    logger.info(f"Reading data from {DATA_FILE}...")
    try:
        with open(DATA_FILE, "r") as f:
            manuals = json.load(f)
    except FileNotFoundError:
        logger.error(f"ERROR: {DATA_FILE} not found.")
        return

    logger.info(f"Found {len(manuals)} entries to ingest.\n")

    logger.info("Connecting to Neo4j...")
    with GraphDatabase.driver(URI, auth=AUTH) as driver:
        with driver.session() as session:

            logger.info("Clearing old database entries...")
            session.execute_write(delete_all_nodes)

            logger.info("Dropping and recreating vector index...")
            session.run("DROP INDEX component_embeddings IF EXISTS")
            session.run("""
                CREATE VECTOR INDEX component_embeddings IF NOT EXISTS
                FOR (c:Component) ON (c.embedding)
                OPTIONS {indexConfig: {
                    `vector.dimensions`: 384,
                    `vector.similarity_function`: 'cosine'
                }}
            """)

            logger.info("Processing and embedding data...\n")
            for item in manuals:
                component = item.get("component", "Unknown")
                car = item.get("car", "Unknown")
                logger.info(f"  Ingesting: {car} / {component}")
                # Embed component name + search_summary so that direct part-name
                # queries ("serpentine belt", "CV axle") align strongly with the
                # stored vector while symptom-only queries still match via the
                # summary. Car-name disambiguation remains in Cypher (WHERE clause)
                # so no car name is added here — that would hurt generic queries.
                embed_text = f"{component}: {item.get('search_summary', component)}"
                vector = get_text_embedding(embed_text)
                session.execute_write(insert_item, item, vector)

    logger.info(f"Ingest complete. {len(manuals)} entries ingested.")
    logger.info("Database is ready for RAG.")


if __name__ == "__main__":
    main()
