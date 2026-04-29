"""
FounderOS — Department Architecture (LangGraph Hierarchical Agents)
====================================================================
Public API:
    build_root_graph()      → compiled root graph (departments as subgraph nodes)
    build_department(name)  → individual compiled department subgraph
    DEPARTMENTS             → list of registered department names
"""
from .root import build_root_graph, run_founderos
from .factory import build_department, DEPARTMENTS

__all__ = ["build_root_graph", "run_founderos", "build_department", "DEPARTMENTS"]
