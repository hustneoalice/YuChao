"""Synchronous bounded compute route; authorization precedes DB acquisition."""
from fastapi import APIRouter, Depends
from app.foundation.db import get_conn
from .auth import authorize
from .contracts import EvaluationRequest, EvaluationResult
from .service import evaluate

router = APIRouter(prefix='/api/v1/neo', tags=['NEO private'])

@router.post('/evaluate', response_model=EvaluationResult, dependencies=[Depends(authorize)], summary='Protected NEO trend calculation')
def evaluate_neo(body: EvaluationRequest, conn=Depends(get_conn)):
    return evaluate(conn, body)
