import { supabase } from "@/lib/models";
import { NextResponse } from "next/server";

export async function DELETE(request: Request) {
    const { sessionId } = await request.json();

    if (!sessionId) {
        return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }

    const { error } = await supabase.from("agent_memory").delete().eq("session_id", sessionId);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
}
