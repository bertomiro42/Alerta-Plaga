import { defineConfig } from "vite";

export default defineConfig({
  // Solo estas variables de .env llegan al navegador. Nunca agregues aquí una llave secreta.
  envPrefix: ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"],
});
