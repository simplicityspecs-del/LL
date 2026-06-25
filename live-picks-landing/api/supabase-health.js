import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return res.status(500).json({
        ok: false,
        error: "Missing Supabase environment variables.",
        supabaseUrlPresent: Boolean(supabaseUrl),
        serviceRoleKeyPresent: Boolean(serviceRoleKey)
      });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const { count, error } = await supabase
      .from("subscribers")
      .select("*", { count: "exact", head: true });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    return res.status(200).json({
      ok: true,
      route: "/api/supabase-health",
      subscribersTableReachable: true,
      subscriberCount: count ?? 0
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Supabase health check failed."
    });
  }
}