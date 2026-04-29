import pytest
from unittest.mock import patch, MagicMock

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from memory import (
    get_collection, 
    store, 
    recall, 
    cross_company_search
)

@patch('memory.client')
def test_get_collection(mock_client):
    """Test dynamic collection fetching respects names and cosine metric."""
    mock_col = MagicMock()
    mock_client.get_or_create_collection.return_value = mock_col
    
    col = get_collection("test_mem")
    mock_client.get_or_create_collection.assert_called_once_with(
        name="test_mem",
        metadata={"hnsw:space": "cosine", "description": "test_mem Memory"}
    )
    assert col == mock_col

@patch('memory.client')
def test_store_and_recall(mock_client):
    """Test ChromaDB store and fetch abstraction."""
    mock_col = MagicMock()
    mock_col.query.return_value = {"documents": [["Test result 1", "Test result 2"]]}
    
    # Store
    store(mock_col, "doc_1", "Hello World", {"tag": "code"})
    mock_col.upsert.assert_called_once_with(
        ids=["doc_1"],
        documents=["Hello World"],
        metadatas=[{"tag": "code"}]
    )
    
    # Recall
    res = recall(mock_col, "Hello", n_results=2)
    assert len(res) == 2
    assert res[0] == "Test result 1"

@patch('memory.recall')
@patch('memory.get_collection')
@patch('registry.get_all_companies')
def test_cross_company_search(mock_companies, mock_get_col, mock_recall):
    """Test hourly ideator cross-company search mechanism."""
    # Mock companies
    comp1, comp2 = MagicMock(), MagicMock()
    comp1.name, comp1.memory_collection = "turicks", "turicks_mem"
    comp2.name, comp2.memory_collection = "naggar", "naggar_mem"
    mock_companies.return_value = [comp1, comp2]
    
    # Mock return
    mock_recall.side_effect = [["turicks insight"], ["naggar insight"]]
    
    results = cross_company_search("test query", 1)
    
    assert "turicks" in results
    assert "naggar" in results
    assert results["turicks"] == ["turicks insight"]
    assert results["naggar"]  == ["naggar insight"]
