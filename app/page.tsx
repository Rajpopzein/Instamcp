export default function Home() {
  return (
    <main
      style={{
        font: '16px/1.7 ui-sans-serif, system-ui, sans-serif',
        maxWidth: '38rem',
        margin: '4rem auto',
        padding: '0 1.25rem',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', marginBottom: '.25rem' }}>Instamcp</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        Remote MCP server for Instagram.
      </p>
      <ul>
        <li>
          <code>/api/mcp</code> — MCP endpoint (bearer auth required)
        </li>
        <li>
          <code>/api/auth/instagram</code> — connect an Instagram account
        </li>
      </ul>
    </main>
  );
}
