// Prints the BOOKX_SIGNIN_PASSWORD_HASH Worker secret for a password, for the
// email + password sign-in the Worker checks (worker/signin.ts).
//
//   SIGNIN_PASSWORD='your password' node scripts/signin-hash.mjs
//   node scripts/signin-hash.mjs < password.txt
//
// Then: npx wrangler secret put BOOKX_SIGNIN_PASSWORD_HASH (paste the output).
// PBKDF2-SHA256 with a random salt, at 100,000 iterations: the most the
// Workers runtime accepts.
import { pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 100_000;

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  // A piped line ends with a newline that is not part of the password.
  return input.replace(/\r?\n$/, "");
}

const password = process.env.SIGNIN_PASSWORD ?? (await readStdin());
if (!password) {
  console.error("Give the password in SIGNIN_PASSWORD, or pipe it in.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
console.log(`pbkdf2-sha256$${ITERATIONS}$${salt.toString("base64url")}$${hash.toString("base64url")}`);
