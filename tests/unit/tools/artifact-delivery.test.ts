/**
 * Unit tests for Phase 3 — Artifact Delivery System.
 * Tests multi-format write_artifact, stat verification, deliver_artifact path confinement,
 * and boot validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { writeArtifactFile, writeArtifactTool } from "../../../src/tools/artifact.js";
import { deliverArtifactFile, deliverArtifactTool } from "../../../src/tools/deliver-artifact.js";
import { assertArtifactRootWritable } from "../../../src/infra/boot-validate.js";
import * as telegramSend from "../../../src/infra/telegram-send.js";

describe("Phase 3 — Artifact Delivery", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-test-"));
  });

  describe("write_artifact", () => {
    it("writes markdown artifact by default", async () => {
      const res = await writeArtifactFile(
        { id: "report_1", title: "Test Report", content: "Body text" },
        "thread1",
        tmpDir,
      );
      expect(res.format).toBe("md");
      expect(res.bytes).toBeGreaterThan(0);
      expect(res.path).toContain("report_1.md");

      const fileContent = await fs.readFile(res.path, "utf-8");
      expect(fileContent).toContain("# Test Report");
      expect(fileContent).toContain("Body text");
    });

    it("writes CSV artifact correctly", async () => {
      const csvData = "company,title,stage\nAcme,AI Engineer,applied\n";
      const res = await writeArtifactFile(
        { id: "jobs_export", content: csvData, format: "csv" },
        "thread1",
        tmpDir,
      );
      expect(res.format).toBe("csv");
      expect(res.bytes).toBe(csvData.length);
      expect(res.path).toContain("jobs_export.csv");

      const fileContent = await fs.readFile(res.path, "utf-8");
      expect(fileContent).toBe(csvData);
    });

    it("fails loudly if write produces 0 bytes", async () => {
      await expect(
        writeArtifactFile({ id: "empty", content: "" }, "thread1", tmpDir),
      ).rejects.toThrow(/produced 0 bytes/);
    });
  });

  describe("deliver_artifact", () => {
    it("rejects file paths outside ARTIFACT_ROOT", async () => {
      const outsideFile = path.join(os.tmpdir(), "malicious.txt");
      await fs.writeFile(outsideFile, "secret", "utf-8");

      await expect(
        deliverArtifactFile({ path: outsideFile }, tmpDir),
      ).rejects.toThrow(/outside ARTIFACT_ROOT/);
    });

    it("rejects 0-byte artifact delivery", async () => {
      const zeroFile = path.join(tmpDir, "zero.txt");
      await fs.writeFile(zeroFile, "", "utf-8");

      await expect(
        deliverArtifactFile({ path: zeroFile }, tmpDir),
      ).rejects.toThrow(/0 bytes/);
    });

    it("delivers valid artifact to Telegram via sendDocument", async () => {
      const sendDocSpy = vi.spyOn(telegramSend, "sendDocument").mockResolvedValue();
      const validFile = path.join(tmpDir, "export.csv");
      await fs.writeFile(validFile, "id,name\n1,test\n", "utf-8");

      const res = await deliverArtifactFile({ path: validFile, caption: "Jobs export" }, tmpDir);
      expect(res.filename).toBe("export.csv");
      expect(res.bytes).toBeGreaterThan(0);
      expect(sendDocSpy).toHaveBeenCalledWith(validFile, "export.csv", { caption: "Jobs export" });
    });
  });

  describe("boot-validation", () => {
    it("asserts artifact root existence and writability", async () => {
      const target = path.join(tmpDir, "boot_artifacts");
      expect(() => assertArtifactRootWritable(target)).not.toThrow();
      await expect(fs.stat(target)).resolves.toBeDefined();
    });
  });
});
