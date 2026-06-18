import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HitlModal } from "../components/HitlModal.js";

describe("HitlModal", () => {
  it("calls onApprove when Approve clicked", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <HitlModal
        pending={{ title: "Send email", summary: "To: test@example.com", preview: "Hello" }}
        busy={false}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });
});
