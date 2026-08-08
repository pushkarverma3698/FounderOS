import { testFullTurn } from "../tests/helpers/bot-context.js";

async function main() {
  console.log("=== P6 POST-DELETION CSV REALITY TEST ===");
  const res = await testFullTurn("what all jobs have been captured give me a csv", {
    chatId: "1",
    username: "turicks",
  });
  console.log("=== RESULT ===");
  console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
