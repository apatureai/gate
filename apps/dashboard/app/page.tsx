import Link from "next/link";
import { getSession } from "@/lib/session";

/** Landing: sign-in link when logged out; an installation chooser when logged in. */
export default async function HomePage() {
  const session = await getSession();

  if (!session) {
    return (
      <section>
        <h1>Sign in</h1>
        <p>Review your repositories&apos; design reviews.</p>
        <Link href="/api/auth/login">Sign in with GitHub</Link>
      </section>
    );
  }

  return (
    <section>
      <h1>Your installations</h1>
      {session.installationIds.length === 0 ? (
        <p>
          No Gate installations found for <strong>{session.login}</strong>. Install the GitHub App on a repository to
          get started.
        </p>
      ) : (
        <ul>
          {session.installationIds.map((id) => (
            <li key={id}>
              <Link href={`/${id}`}>Installation {id}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
