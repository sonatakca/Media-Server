import { stdin, stdout } from "node:process";
import { StringDecoder } from "node:string_decoder";
import { createDatabasePool } from "../src/server/ownApi/database/databasePool";
import { parseDatabaseConfig } from "../src/server/ownApi/database/databaseConfig";
import { createArgon2PasswordHasher } from "../src/server/ownApi/auth/passwords";
import {
  InitialAdministratorExistsError,
  provisionInitialAdministrator,
} from "../src/server/ownApi/auth/provisioningService";

interface Arguments {
  username: string;
  displayName: string;
  passwordStdin: boolean;
}

function parseArguments(values: string[]): Arguments {
  let username: string | undefined;
  let displayName: string | undefined;
  let passwordStdin = false;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--username") {
      username = values[++index];
    } else if (value === "--display-name") {
      displayName = values[++index];
    } else if (value === "--password-stdin") {
      passwordStdin = true;
    } else {
      throw new Error(`Unknown argument: ${value ?? ""}`);
    }
  }

  if (!username || !displayName) {
    throw new Error("--username and --display-name are required.");
  }

  return { username, displayName, passwordStdin };
}

async function readPasswordFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 4_096) {
      throw new Error("Password input is too large.");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/[\r\n]+$/, "");
}

function promptHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) {
    throw new Error(
      "A TTY is required for the secure prompt; use --password-stdin with protected input.",
    );
  }

  return new Promise((resolve, reject) => {
    let password = "";
    const decoder = new StringDecoder("utf8");
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(password);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const character of decoder.write(buffer)) {
        const codePoint = character.codePointAt(0);
        if (codePoint === 3) {
          finish(new Error("Provisioning cancelled."));
          return;
        }
        if (codePoint === 13 || codePoint === 10) {
          finish();
          return;
        }
        if (codePoint === 127 || codePoint === 8) {
          password = Array.from(password).slice(0, -1).join("");
          continue;
        }
        password += character;
        if (Buffer.byteLength(password, "utf8") > 4_096) {
          finish(new Error("Password input is too large."));
          return;
        }
      }
    };

    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const password = args.passwordStdin
    ? await readPasswordFromStdin()
    : await promptHidden("Password: ");
  const confirmation = args.passwordStdin
    ? password
    : await promptHidden("Confirm password: ");

  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }

  const config = parseDatabaseConfig({
    ...process.env,
  });
  if (!config) {
    throw new Error("Native database configuration is unavailable.");
  }

  const pool = createDatabasePool(config);
  try {
    await provisionInitialAdministrator({
      pool,
      passwords: createArgon2PasswordHasher(),
      username: args.username,
      displayName: args.displayName,
      password,
    });
    console.info("Created initial native administrator.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message =
    error instanceof InitialAdministratorExistsError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unknown error";
  console.error("Initial administrator provisioning failed:", message);
  process.exitCode = 1;
});
