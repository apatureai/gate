import { buildProposeConfigUrl, copyableConfig, validateConfig } from "@gate/dashboard";
import { requireInstallation } from "@/lib/session";

/**
 * Config editor. Gate writes nothing (no `contents: write`): "Propose" deep-links
 * into GitHub's own new-file editor so the USER opens the PR (#18). Validation is
 * the core `validateConfig`.
 */
export default async function ConfigPage({
  params,
  searchParams,
}: {
  params: Promise<{ installationId: string }>;
  searchParams: Promise<{ owner?: string; name?: string; yaml?: string }>;
}) {
  const { installationId } = await params;
  await requireInstallation(Number(installationId));
  const { owner, name, yaml } = await searchParams;

  if (!owner || !name) {
    return <p>Select a repository from the installation page to edit its config.</p>;
  }

  const yamlText = yaml ?? "";
  const validation = yamlText ? validateConfig(yamlText) : null;
  const proposeUrl =
    validation?.ok && yamlText ? buildProposeConfigUrl({ owner, name, yamlText: copyableConfig(yamlText) }) : null;

  return (
    <section>
      <h1>
        Config — {owner}/{name}
      </h1>
      <form method="get" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input type="hidden" name="owner" value={owner} />
        <input type="hidden" name="name" value={name} />
        <textarea name="yaml" rows={14} defaultValue={yamlText} style={{ fontFamily: "monospace", padding: 8 }} />
        <button type="submit">Validate</button>
      </form>
      {validation && (
        <div style={{ marginTop: 12 }}>
          {validation.ok ? (
            <p style={{ color: "#137333" }}>Valid configuration.</p>
          ) : (
            <ul style={{ color: "#b3261e" }}>
              {validation.issues.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {proposeUrl && (
        <p style={{ marginTop: 12 }}>
          <a href={proposeUrl}>Open a PR with this config on GitHub →</a> (Gate never writes to your repo.)
        </p>
      )}
    </section>
  );
}
