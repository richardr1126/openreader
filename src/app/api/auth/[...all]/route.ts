import { auth } from "@/lib/server/auth/auth"; // path to your auth file
import { toNextJsHandler } from "better-auth/next-js";

const handlers = auth
  ? toNextJsHandler(auth)
  : {
    POST: async () => new Response("Auth disabled", { status: 404 }),
    GET: async () => new Response("Auth disabled", { status: 404 })
  };

export const { POST, GET } = handlers;