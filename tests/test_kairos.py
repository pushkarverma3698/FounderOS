import pytest
from unittest.mock import patch

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from kairos_background import auto_dream_consolidation

@pytest.mark.asyncio
@patch('kairos_background.turicks_mem')
@patch('kairos_background.naggar_mem')
@patch('kairos_background.store')
@patch('kairos_background.call_local')
async def test_kairos_procedural_memory(mock_call_local, mock_store, mock_naggar, mock_turicks):
    """Test Sleep-Time Compute correctly creates procedural caches."""
    mock_turicks.get.return_value = {
        "documents": ["Insight from 2024"] * 6 # Provide enough documents to trigger consolidation
    }
    mock_naggar.get.return_value = {"documents": []}
    mock_call_local.return_value = '[{"problem": "X", "solution": "Y", "steps": []}]'
    
    await auto_dream_consolidation()
    
    # Check that it attempted to store the compiled document
    assert mock_store.call_count >= 1
