import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";

export function LoginPage() {
  const [name, setName] = useState("");
  const navigate = useNavigate();
  const setDisplayName = useAuthStore((state) => state.setDisplayName);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const displayName = name.trim() || `User-${Math.random().toString(16).slice(2, 6)}`;
    setDisplayName(displayName);
    navigate("/rooms");
  }

  return (
    <section className="page-card narrow" style={{ marginTop: "10vh" }}>
      <p className="eyebrow">👋 Welcome</p>
      <h2>Enter the Project Room</h2>
      <p style={{ color: "#94a3b8", marginBottom: 24 }}>
        Choose a display name to join the collaborative space.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "grid", gap: 16 }}>
        <div>
          <label style={{ fontSize: 13, color: "#cbd5e1", marginBottom: 6, display: "block" }}>
            Your name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alice"
            autoFocus
          />
        </div>

        <Button type="submit" variant="primary">
          Enter Room →
        </Button>
      </form>
    </section>
  );
}
