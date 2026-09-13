import { chromium, type Page, type Browser } from "playwright";
import { childLogger } from "../../infra/logger.js";
import { getProfile } from "./profile-config.js";
import { z } from "zod";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";

const log = childLogger({ module: "ats-submitter" });

export interface SubmitContext {
  applyUrl: string;
  pdfPath: string;
  cvMarkdown: string;
  profileId?: string;
  jobDescription?: string;
}

const FILL_FIELD_TOOL = {
  name: "fill_field",
  description: "Fills a text input, textarea, or select element identified by its CSS selector.",
  schema: z.object({
    selector: z.string().describe("The CSS selector of the field"),
    value: z.string().describe("The text to type or option to select"),
  }),
};

const UPLOAD_FILE_TOOL = {
  name: "upload_file",
  description: "Uploads a file to an input[type=file] element.",
  schema: z.object({
    selector: z.string().describe("The CSS selector of the file input"),
  }),
};

const CLICK_SUBMIT_TOOL = {
  name: "click_submit",
  description: "Clicks the final submit button to send the application.",
  schema: z.object({
    selector: z.string().describe("The CSS selector of the submit button"),
  }),
};

export async function submitApplication(ctx: SubmitContext): Promise<{ ok: boolean; reason?: string }> {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 FounderOS/1.0" });

    log.info({ applyUrl: ctx.applyUrl }, "Opening ATS form");
    await page.goto(ctx.applyUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const profile = getProfile(ctx.profileId);
    
    // 1. Extract form fields via JS
    const formFields = await page.evaluate(() => {
      // @ts-ignore - document is available in browser context
      const inputs = Array.from(document.querySelectorAll('input, textarea, select, button'));
      return inputs.map((el: any, i: number) => {
        const id = el.id || `el-${i}`;
        el.setAttribute('data-agent-id', id);
        return {
          id,
          tag: el.tagName.toLowerCase(),
          type: el.type,
          name: el.name,
          label: el.parentElement?.innerText || el.previousElementSibling?.innerText || "",
          selector: `[data-agent-id="${id}"]`
        };
      }).filter((f: any) => f.type !== 'hidden');
    });

    // 2. Init LLM
    const llm = new ChatAnthropic({
      modelName: "claude-3-5-sonnet-20240620",
      temperature: 0.1,
    }).bindTools([FILL_FIELD_TOOL, UPLOAD_FILE_TOOL, CLICK_SUBMIT_TOOL]);

    const messages: BaseMessage[] = [
      new SystemMessage(`You are an autonomous ATS application submitter.
Your goal is to fill out the form provided and click submit.
You have the following context about the candidate:
Name: ${profile.candidateName}
CV:
${ctx.cvMarkdown}

Job Description:
${ctx.jobDescription ?? "No description provided."}

The form has the following fields:
${JSON.stringify(formFields, null, 2)}

Instructions:
1. Call fill_field for all required fields. Improvise answers for textareas based on the CV and JD.
2. Call upload_file for the resume/CV upload field.
3. Call click_submit on the submit button.
Do this efficiently in as few tool calls as possible.`),
      new HumanMessage("Please fill out the form.")
    ];

    let loopCount = 0;
    while (loopCount < 10) {
      loopCount++;
      const res = await llm.invoke(messages);
      messages.push(res);

      if (!res.tool_calls || res.tool_calls.length === 0) {
        break; // LLM finished
      }

      for (const call of res.tool_calls) {
        let toolResponse = "";
        try {
          if (call.name === "fill_field") {
            const { selector, value } = call.args as any;
            await page.fill(selector, value);
            toolResponse = "Success";
          } else if (call.name === "upload_file") {
            const { selector } = call.args as any;
            await page.setInputFiles(selector, ctx.pdfPath);
            toolResponse = "Success";
          } else if (call.name === "click_submit") {
            const { selector } = call.args as any;
            await page.click(selector);
            toolResponse = "Success";
          }
        } catch (err) {
          toolResponse = `Error: ${(err as Error).message}`;
        }
        messages.push(new ToolMessage({ tool_call_id: call.id!, content: toolResponse, name: call.name }));
      }
    }

    return { ok: true };
  } catch (err) {
    const reason = (err as Error).message;
    log.error({ applyUrl: ctx.applyUrl, err: reason }, "ATS Submitter failed");
    return { ok: false, reason };
  } finally {
    if (browser) await browser.close();
  }
}
