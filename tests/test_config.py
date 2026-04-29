import pytest
import time
from unittest.mock import patch, MagicMock

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from config import (
    call_with_fallback, 
    _cb_failures, 
    _cb_tripped_at, 
    CIRCUIT_BREAKER_MAX,
    _tpm_check_and_record,
    _tpm_usage,
    _jitter_backoff
)

@pytest.fixture(autouse=True)
def reset_state():
    """Reset global circuit breaker and TPM states before each test."""
    _cb_failures.clear()
    _cb_tripped_at.clear()
    _tpm_usage.clear()

def test_tpm_check_budget():
    """Test that TPM tracker correctly rejects requests exceeding budget."""
    provider = "test_provider"
    # Artificially set limit for this test via mock or rely on default 50k
    with patch('config.TPM_LIMITS', {provider: 100}):
        # Send 80 tokens (should pass)
        assert _tpm_check_and_record(provider, "x" * 160, "x" * 160) == True
        # Send 40 tokens (should fail, budget exhausted)
        assert _tpm_check_and_record(provider, "x" * 160, "") == False

def test_jitter_backoff():
    """Test that exponential backoff with jitter returns appropriate bounds."""
    for attempt in range(5):
        val = _jitter_backoff(attempt, base_secs=1.0, cap_secs=10.0)
        assert 0.0 <= val <= 10.0

@patch('config.httpx.post')
@patch('config.time.sleep')
def test_fallback_cascade_success_first(mock_sleep, mock_post):
    """Test cascade succeeds on the first try without falling back."""
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"choices": [{"message": {"content": "mocked ceo answer"}}]}
    mock_resp.status_code = 200
    mock_post.return_value = mock_resp

    cascade = [("openrouter", "model1"), ("openrouter", "model2")]
    
    result = call_with_fallback(cascade, "Hello", cascade_name="TEST_CASCADE")
    assert result == "mocked ceo answer"
    assert mock_post.call_count == 1
    assert _cb_failures["TEST_CASCADE"] == 0

@patch('config.httpx.post')
@patch('config.time.sleep')
def test_fallback_cascade_exhausted(mock_sleep, mock_post):
    """Test cascade fails all options and throws RuntimeError."""
    mock_post.side_effect = Exception("API Down")

    cascade = [("openrouter", "model1"), ("openrouter", "model2")]
    
    with pytest.raises(RuntimeError, match="All cascade models failed"):
        call_with_fallback(cascade, "Hello", cascade_name="TEST_CASCADE")
        
    assert mock_post.call_count == 2
    assert _cb_failures["TEST_CASCADE"] == 1

def test_circuit_breaker_trips():
    """Test that completing CIRCUIT_BREAKER_MAX failures trips the breaker."""
    cascade = [("fake_provider", "fake_model")]
    
    # Simulate failed attempts
    for _ in range(CIRCUIT_BREAKER_MAX):
        with pytest.raises(RuntimeError):
            call_with_fallback(cascade, "Test", cascade_name="CB_TEST")
            
    assert _cb_failures["CB_TEST"] == CIRCUIT_BREAKER_MAX
    
    # Next attempt should instantly fail with circuit breaker open error
    with pytest.raises(RuntimeError, match="Circuit breaker OPEN"):
        call_with_fallback(cascade, "Test", cascade_name="CB_TEST")
