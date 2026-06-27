import uvicorn
from backend.config import PORT

if __name__ == "__main__":
    print(f"Booting Aether RAG Service on http://127.0.0.1:{PORT}...")
    uvicorn.run("backend.main:app", host="127.0.0.1", port=PORT, reload=True)
