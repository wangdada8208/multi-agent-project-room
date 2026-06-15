import { Link } from "react-router-dom";

export function LoginPage() {
  return (
    <section className="page-card narrow">
      <p className="eyebrow">Mock Login</p>
      <h2>Authentication comes later</h2>
      <p>
        The MVP plan leaves auth relaxed for now. This placeholder keeps the route ready
        for the real login flow.
      </p>
      <Link className="primary-link" to="/rooms/demo-room">
        Enter demo room
      </Link>
    </section>
  );
}
