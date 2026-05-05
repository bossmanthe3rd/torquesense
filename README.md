# TorqueSense AI

TorqueSense is an AI-powered automotive diagnostic assistant designed to help users identify and repair vehicle issues using advanced multimodal AI and graph-based semantic search.

## Features

*   **Multimodal Diagnostics**: Upload images of car parts or audio of car sounds, and describe symptoms via text. TorqueSense leverages Google's **Gemini 2.5 Flash** model to analyze these inputs and extract meaningful automotive diagnostic signals.
*   **Semantic Graph Search**: Automotive repair manuals are stored in a **Neo4j** graph database. The system uses local semantic embeddings (`all-MiniLM-L6-v2` via `sentence-transformers`) to accurately match user symptoms and detected parts to the correct repair procedures.
*   **Context-Aware AI Responses**: Gemini acts as a Master Mechanic, generating step-by-step repair instructions strictly grounded in the official repair manual context retrieved from the database.
*   **Knowledge Graph Visualization**: View an interactive graph of car components, symptoms, and manuals directly in the UI.

## Architecture

*   **Frontend**: React (Vite)
*   **Backend**: Python (FastAPI)
*   **Database**: Neo4j (Graph Database with Vector Indexing)
*   **AI Models**: Google Gemini (Vision, Audio Transcription, Generative Chat) & SentenceTransformers (Semantic Embeddings)

## How to Run (Local Development)

The application is fully containerized using Docker Compose for seamless local development.

### Prerequisites

*   [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.
*   A valid Google Gemini API Key.

### Setup Instructions

1.  **Environment Variables**:
    *   Navigate to the `backend/` directory.
    *   Copy `.env.example` to `.env`.
    *   Add your valid Gemini API key to the `GEMINI_API_KEY` variable in the `.env` file.

2.  **Start Services**:
    From the root directory of the project, spin up the database, backend, and frontend containers:
    ```bash
    docker compose up --build
    ```

3.  **Ingest Initial Data**:
    Before using the app, you must populate the Neo4j database with the repair manuals. While the containers are running, open a new terminal and execute the ingest script inside the backend container:
    ```bash
    docker compose exec backend python ingest.py
    ```
    *This script reads `backend/data/manuals.json`, generates semantic embeddings, and stores them in the Neo4j graph.*

4.  **Access the Application**:
    *   **Frontend**: [http://localhost:5173](http://localhost:5173)
    *   **Backend API Docs**: [http://localhost:8000/docs](http://localhost:8000/docs)
    *   **Neo4j Browser**: [http://localhost:7474](http://localhost:7474) (Local development only, auth is disabled)
