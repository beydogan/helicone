import { BatchPayload } from "../handlers/LoggingHandler";
import { deepCompare } from "../../utils/helpers";
import pgPromise from "pg-promise";
import { PromptRecord } from "../handlers/HandlerContext";
import { PromiseGenericResult, ok, err } from "../shared/result";
import { Database } from "../db/database.types";

const pgp = pgPromise();
const db = pgp({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl:
    process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "development"
      ? {
          rejectUnauthorized: true,
          ca: process.env.SUPABASE_SSL_CERT_CONTENTS?.split("\\n").join("\n"),
        }
      : undefined,
});

process.on("exit", () => {
  pgp.end();
});

const requestColumns = new pgp.helpers.ColumnSet(
  [
    "id",
    "auth_hash",
    "body",
    "path",
    "provider",
    "created_at",
    { name: "formatted_prompt_id", def: null }, // Default to null if not provided
    { name: "helicone_api_key_id", def: null },
    { name: "helicone_org_id", def: null },
    { name: "helicone_proxy_key_id", def: null },
    { name: "helicone_user", def: null },
    { name: "model", def: null },
    { name: "model_override", def: null },
    { name: "prompt_id", def: null },
    { name: "prompt_values", def: null },
    { name: "properties", def: null },
    { name: "request_ip", def: null },
    { name: "target_url", def: null },
    { name: "threat", def: null },
    { name: "user_id", def: null },
    { name: "country_code", def: null },
  ],
  { table: "request" }
);
const onConflictRequest =
  " ON CONFLICT (id, helicone_org_id) DO UPDATE SET " +
  requestColumns.assignColumns({ from: "EXCLUDED", skip: "id" });

const responseColumns = new pgp.helpers.ColumnSet(
  [
    "id",
    "body",
    "request",
    "created_at",
    { name: "helicone_org_id", def: null },
    { name: "model", def: null },
    { name: "completion_tokens", def: null },
    { name: "delay_ms", def: null },
    { name: "feedback", def: null },
    { name: "prompt_tokens", def: null },
    { name: "status", def: null },
    { name: "time_to_first_token", def: null },
  ],
  { table: "response" }
);

const onConflictResponse =
  " ON CONFLICT (request, helicone_org_id) DO UPDATE SET " +
  responseColumns.assignColumns({ from: "EXCLUDED", skip: "id" });

const assetColumns = new pgp.helpers.ColumnSet(
  ["id", "request_id", "organization_id", "created_at"],
  { table: "asset" }
);

const onConflictAsset = " ON CONFLICT (id, request_id) DO NOTHING";

const requestResponseSearchColumns = new pgp.helpers.ColumnSet(
  [
    "request_id",
    { name: "request_body_vector", mod: "^" },
    { name: "response_body_vector", mod: "^" },
  ],
  { table: "request_response_search" }
);

const onConflictRequestResponseSearch =
  " ON CONFLICT (request_id) DO UPDATE SET " +
  requestResponseSearchColumns.assignColumns({
    from: "EXCLUDED",
    skip: "request_id",
  });

interface Message {
  role: string;
  content: string;
}

interface RequestBody {
  messages: Message[];
}

interface Choice {
  message: {
    role: string;
    content: string;
  };
}

interface ResponseBody {
  choices: Choice[];
}

export class LogStore {
  constructor() {}

  async insertLogBatch(payload: BatchPayload): PromiseGenericResult<string> {
    try {
      await db.tx(async (t: pgPromise.ITask<{}>) => {
        // Insert into the 'request' table
        if (payload.requests && payload.requests.length > 0) {
          const filteredRequests = this.filterDuplicateRequests(
            payload.requests
          );

          try {
            const insertRequest =
              pgp.helpers.insert(filteredRequests, requestColumns) +
              onConflictRequest;
            await t.none(insertRequest);
          } catch (error) {
            console.error("Error inserting request", error);
            throw error;
          }
        }

        // Insert into the 'response' table with conflict resolution
        if (payload.responses && payload.responses.length > 0) {
          const filteredResponses = this.filterDuplicateResponses(
            payload.responses
          );

          try {
            const insertResponse =
              pgp.helpers.insert(filteredResponses, responseColumns) +
              onConflictResponse;
            await t.none(insertResponse);
          } catch (error) {
            console.error("Error inserting response", error);
            throw error;
          }
        }

        if (payload.assets && payload.assets.length > 0) {
          const insertResponse =
            pgp.helpers.insert(payload.assets, assetColumns) + onConflictAsset;
          await t.none(insertResponse);
        }

        if (payload.prompts && payload.prompts.length > 0) {
          payload.prompts.sort((a, b) => {
            if (a.createdAt && b.createdAt) {
              if (a.createdAt < b.createdAt) {
                return -1;
              }
              if (a.createdAt > b.createdAt) {
                return 1;
              }
            }
            return 0;
          });

          for (const promptRecord of payload.prompts) {
            await this.processPrompt(promptRecord, t);
          }
        }
      });

      return ok("Successfully inserted log batch");
    } catch (error: any) {
      return err("Failed to insert log batch: " + error);
    }
  }

  async processPrompt(
    newPromptRecord: PromptRecord,
    t: pgPromise.ITask<{}>
  ): PromiseGenericResult<string> {
    const { promptId, orgId, requestId, heliconeTemplate, model } =
      newPromptRecord;

    if (!heliconeTemplate) {
      return ok("No Helicone template to process");
    }

    // Ensure the prompt exists or create it, and lock the row
    let existingPrompt = await t.oneOrNone<{
      id: string;
    }>(
      `SELECT id FROM prompt_v2 WHERE organization = $1 AND user_defined_id = $2`,
      [orgId, promptId]
    );
    if (!existingPrompt) {
      try {
        existingPrompt = await t.one<{
          id: string;
        }>(
          `INSERT INTO prompt_v2 (user_defined_id, organization, created_at) VALUES ($1, $2, $3) RETURNING id`,
          [promptId, orgId, newPromptRecord.createdAt]
        );
      } catch (error) {
        console.error("Error inserting prompt", error);
        throw error;
      }
    }

    // Check the latest version and decide whether to update
    const existingPromptVersion = await t.oneOrNone<{
      id: string;
      major_version: number;
      helicone_template: any;
      created_at: Date;
    }>(
      `SELECT id, major_version, helicone_template, created_at FROM prompts_versions 
       WHERE organization = $1 AND prompt_v2 = $2 ORDER BY major_version DESC LIMIT 1`,
      [orgId, existingPrompt.id]
    );

    let versionId = existingPromptVersion?.id ?? "";

    // Check if an update is necessary based on template comparison
    if (
      !existingPromptVersion ||
      (existingPromptVersion &&
        existingPromptVersion.created_at <= newPromptRecord.createdAt &&
        !deepCompare(
          existingPromptVersion.helicone_template,
          heliconeTemplate.template
        ))
    ) {
      // Create a new version if the template has changed
      let majorVersion = existingPromptVersion
        ? existingPromptVersion.major_version + 1
        : 0;
      try {
        const newVersionResult = await t.one(
          `INSERT INTO prompts_versions (prompt_v2, organization, major_version, minor_version, helicone_template, model, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            existingPrompt.id,
            orgId,
            majorVersion,
            0,
            heliconeTemplate.template,
            model,
            newPromptRecord.createdAt,
          ]
        );
        versionId = newVersionResult.id;
      } catch (error) {
        console.error("Error inserting prompt version", error);
        throw error;
      }
    }

    // Insert or update prompt input keys if there's a new version or no existing version
    if (versionId && Object.keys(heliconeTemplate.inputs).length > 0) {
      try {
        await t.none(
          `INSERT INTO prompt_input_keys (key, prompt_version, created_at)
         SELECT unnest($1::text[]), $2, $3
         ON CONFLICT (key, prompt_version) DO NOTHING`,
          [
            `{${Object.keys(heliconeTemplate.inputs).join(",")}}`,
            versionId,
            newPromptRecord.createdAt.toISOString(),
          ]
        );
      } catch (error) {
        console.error("Error inserting prompt input keys", error);
        throw error;
      }

      try {
        // Record the inputs and source request
        await t.none(
          `INSERT INTO prompt_input_record (inputs, source_request, prompt_version, created_at)
         VALUES ($1, $2, $3, $4)`,
          [
            JSON.stringify(heliconeTemplate.inputs),
            requestId,
            versionId,
            newPromptRecord.createdAt.toISOString(),
          ]
        );
      } catch (error) {
        console.error("Error inserting prompt input record", error);
        throw error;
      }
    }

    return ok("Prompt processed successfully");
  }

  filterDuplicateRequests(
    entries: Database["public"]["Tables"]["request"]["Insert"][]
  ) {
    const entryMap = new Map<
      string,
      Database["public"]["Tables"]["request"]["Insert"]
    >();

    entries.forEach((entry) => {
      if (!entry.id) {
        return;
      }

      const existingEntry = entryMap.get(entry.id);

      // No existing entry, add it
      if (!existingEntry || !existingEntry.created_at) {
        entryMap.set(entry.id, entry);
        return;
      }

      if (
        entry.created_at &&
        new Date(entry.created_at) < new Date(existingEntry.created_at)
      ) {
        entryMap.set(entry.id, entry);
      }
    });

    return Array.from(entryMap.values());
  }

  filterDuplicateResponses(
    entries: Database["public"]["Tables"]["response"]["Insert"][]
  ) {
    const entryMap = new Map<
      string,
      Database["public"]["Tables"]["response"]["Insert"]
    >();

    entries.forEach((entry) => {
      if (!entry.request) {
        return;
      }

      const existingEntry = entryMap.get(entry.request);

      // No existing entry, add it
      if (!existingEntry || !existingEntry.created_at) {
        entryMap.set(entry.request, entry);
        return;
      }

      if (
        entry.created_at &&
        new Date(entry.created_at) < new Date(existingEntry.created_at)
      ) {
        entryMap.set(entry.request, entry);
      }
    });

    return Array.from(entryMap.values());
  }

  async insertRequestResponseSearch(
    requestResponseData: {
      requestId: string;
      requestBody: string;
      responseBody: string;
    }[]
  ): PromiseGenericResult<string> {
    try {
      await db.tx(async (t: pgPromise.ITask<{}>) => {
        try {
          console.log("requestBody", requestResponseData[0].requestBody);
          console.log("responseBody", requestResponseData[0].responseBody);
          const searchRecords = requestResponseData.map((request) => {
            return {
              request_id: request.requestId,
              request_body_vector: `to_tsvector('simple', ${pgp.as.text(
                this.pullRequestBodyMessage(request.requestBody)
              )})`,
              response_body_vector: `to_tsvector('simple', ${pgp.as.text(
                this.pullResponseBodyMessage(request.responseBody)
              )})`,
            };
          });
          const insertRequestResponseSearch =
            pgp.helpers.insert(searchRecords, requestResponseSearchColumns) +
            onConflictRequestResponseSearch;
          await t.none(insertRequestResponseSearch);
        } catch (error) {
          console.error("Error inserting request response search", error);
          throw error;
        }
      });

      return ok("Successfully insegrted request response search");
    } catch (error: any) {
      return err("Failed to insert request response search: " + error);
    }
  }

  private pullRequestBodyMessage(requestBody: any): string {
    try {
      const messagesArray = requestBody.messages;

      if (!Array.isArray(messagesArray)) {
        throw new Error(
          "Invalid request body format: messages array is missing or not an array"
        );
      }

      const allMessages = messagesArray
        .filter((message) => {
          return message.role === "user";
        })
        .map((message) => {
          if (typeof message === "object" && message !== null) {
            return message["content"] || "";
          }
          return "";
        })
        .join(" ");

      return allMessages.trim();
    } catch (error) {
      console.error("Error pulling request body messages:", error);
      return "";
    }
  }

  private pullResponseBodyMessage(responseBody: any): string {
    try {
      const choicesArray = responseBody.choices;

      if (!Array.isArray(choicesArray)) {
        throw new Error(
          "Invalid response body format: choices array is missing or not an array"
        );
      }

      const allMessages = choicesArray
        .filter((choice) => {
          return choice.message.role === "assistant";
        })
        .map((choice) => {
          return choice.message.content || "";
        })
        .join(" ");

      return allMessages.trim();
    } catch (error) {
      console.error("Error pulling response body messages:", error);
      return "";
    }
  }
}
