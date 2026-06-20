// The "result" page shown after Send: displays the uploaded file and the answer.

export default function DocumentPage({ document, answer, prompt, onBack }) {
  const rawUrl = `/api/documents/${document.id}/raw`;

  return (
    <main className="container">
      <button type="button" className="link-button" onClick={onBack}>
        ← Back
      </button>

      <h1>{document.name}</h1>

      {prompt && (
        <section className="card">
          <h2>Your prompt</h2>
          <p>{prompt}</p>
        </section>
      )}

      <section className="card">
        <h2>Uploaded file</h2>
        {document.is_text ? (
          <pre className="file-content">{document.text}</pre>
        ) : (
          <div className="file-preview">
            <iframe title={document.name} src={rawUrl} className="file-frame" />
            <p>
              <a href={rawUrl} target="_blank" rel="noreferrer">
                Open / download {document.name}
              </a>
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
