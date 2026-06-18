import { useEffect, useRef } from "react";
import type { StreamLine } from "../lib/types.js";
import { renderMarkdown } from "../lib/markdown.js";

interface ChatFeedProps {
  lines: StreamLine[];
}

export function ChatFeed({ lines }: ChatFeedProps) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo(0, feedRef.current.scrollHeight);
  }, [lines]);

  return (
    <div className="feed" ref={feedRef}>
      {lines.length === 0 && (
        <p className="placeholder">
          Talk to your office. Streaming tool calls and routing appear here.
        </p>
      )}
      {lines.map((l) => (
        <div key={l.id} className={`line line-${l.type}`}>
          <time>{l.ts}</time>
          {l.type === "assistant" ? (
            <span dangerouslySetInnerHTML={{ __html: renderMarkdown(l.text) }} />
          ) : (
            <span>{l.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}
