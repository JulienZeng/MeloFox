import { randomBytes } from "node:crypto";

function generateApiKey() {
  return "sk-" + randomBytes(32).toString("base64url");
}

console.log(generateApiKey());
