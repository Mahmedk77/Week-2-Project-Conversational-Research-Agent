import { supabase } from "@/lib/models";
import { NextResponse } from "next/server";

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export async function DELETE(request: Request) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { sessionId } = (body ?? {}) as { sessionId?: unknown };

    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    const { error } = await supabase.from("agent_memory").delete().eq("session_id", sessionId);

    if (error) {
        // Don't leak database error details to the client.
        console.error("clear memory error:", error.message);
        return NextResponse.json({ error: "Failed to clear memory" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
}
