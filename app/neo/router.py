"""Synchronous bounded compute route; authorization precedes DB acquisition."""
from fastapi import APIRouter, Depends, HTTPException
from .auth import authorize
from .contracts import EvaluationRequest, EvaluationResult
from .service import evaluate

router = APIRouter(prefix='/api/v1/neo', tags=['NEO private'])

@router.post('/evaluate', response_model=EvaluationResult, summary='Protected NEO indicator calculation on supplied prices')
def evaluate_neo(body: EvaluationRequest, claims=Depends(authorize)):
    if (claims.get('input_snapshot_id') != body.input_snapshot_id
            or claims.get('scope') != body.capability):
        raise HTTPException(401, 'NEO input authorization invalid')
    return evaluate(body)
