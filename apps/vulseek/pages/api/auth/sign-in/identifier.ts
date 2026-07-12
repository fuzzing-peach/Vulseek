import { auth } from "@vulseek/server/index";
import { toNodeHandler } from "better-auth/node";

export const config = { api: { bodyParser: false } };

export default toNodeHandler(auth.signInWithIdentifier);
