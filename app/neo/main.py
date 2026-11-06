"""Standalone private algorithms: no market database, updater, or dashboard."""
from fastapi import FastAPI
from .router import router

app = FastAPI(title='NEO Private Compute', docs_url=None, redoc_url=None)
app.include_router(router)


@app.get('/health', summary='Private compute process health')
def health():
    return {'status': 'ok'}
