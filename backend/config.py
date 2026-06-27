import os
from pathlib import Path
from dotenv import load_dotenv

# Project Paths
BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CHROMA_DIR = str(BASE_DIR / "data" / "chroma_db")

# Load environment variables from .env if it exists
load_dotenv(dotenv_path=BASE_DIR / ".env", override=True)

# Configuration Variables
CHROMA_DB_DIR = os.getenv("CHROMA_DB_DIR", DEFAULT_CHROMA_DIR)
PORT = int(os.getenv("PORT", "8000"))

# RAG Settings
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
LLM_MODEL = os.getenv("LLM_MODEL", "llama3")
DEFAULT_CHUNK_SIZE = 1000
DEFAULT_CHUNK_OVERLAP = 200

# Helper to resolve API key (no-op since we run locally without key)
def get_api_key(client_key: str = "") -> str:
    return ""
