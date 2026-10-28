import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const sb = createClient(config.supabaseUrl, config.supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

export const IMAGE_BUCKET = "sc-images";
