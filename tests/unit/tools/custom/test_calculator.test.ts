/** Unit test for synthesized skill: test_calculator */
import { describe, it, expect } from "vitest";
import { addNumbers } from "../../../src/tools/custom/test_calculator.js";
it("adds", () => { expect(addNumbers(2, 3)).toBe(5); });
