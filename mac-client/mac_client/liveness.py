from urllib.parse import urlparse

def classify_response(status: int, requested_url: str, final_url: str, redirected: bool) -> str:
    if redirected:
        try:
            req_parsed = urlparse(requested_url)
            final_parsed = urlparse(final_url)
            
            error_markers = ["error=true", "/not-found", "/expired"]
            if any(marker in final_url for marker in error_markers):
                return "expired"
            
            final_path = final_parsed.path.rstrip("/")
            if final_path in ("", "/jobs", "/careers"):
                return "expired"
            
            req_segments = [s for s in req_parsed.path.split("/") if s]
            if req_segments:
                last_segment = req_segments[-1]
                if last_segment in final_parsed.path:
                    return "live"
            
            return "unverifiable"
        except Exception:
            return "unverifiable"
            
    if status in (404, 410):
        return "expired"
    if 200 <= status < 400:
        return "live"
    return "unverifiable"
