package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

const sampleSession = `{"type":"session","id":"session-id","name":"A local session","cwd":"/project","timestamp":"2026-01-01T10:00:00Z"}
{"type":"message","id":"user-1","parentId":null,"timestamp":"2026-01-01T10:01:00Z","message":{"role":"user","content":[{"type":"text","text":"Keep this private"}]}}
{"type":"message","id":"assistant-1","parentId":"user-1","timestamp":"2026-01-01T10:02:00Z","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"usage":{"totalTokens":123,"cost":{"total":0.012}}}}
`

func writeFixture(t *testing.T, root, project, filename, contents string) string {
	t.Helper()
	dir := filepath.Join(root, project)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, filename)
	if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func testServer(t *testing.T) (*server, string) {
	t.Helper()
	dir := t.TempDir()
	writeFixture(t, dir, "--home--project--", "session.jsonl", sampleSession)
	s := newServer(dir)
	t.Cleanup(s.Close)
	return s, "--home--project--/session.jsonl"
}

func request(t *testing.T, s *server, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://localhost:27183"+path, strings.NewReader(body))
	for name, value := range headers {
		r.Header.Set(name, value)
	}
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	return w
}

func TestSessionEndpoints(t *testing.T) {
	s, id := testServer(t)
	for _, path := range []string{"/", "/session?id=" + url.QueryEscape(id), "/api/session?id=" + url.QueryEscape(id), "/export?id=" + url.QueryEscape(id)} {
		t.Run(path, func(t *testing.T) {
			w := request(t, s, "GET", path, "", nil)
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			for header, want := range map[string]string{"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"} {
				if got := w.Header().Get(header); got != want {
					t.Errorf("%s = %q, want %q", header, got, want)
				}
			}
			if !strings.Contains(w.Header().Get("Content-Security-Policy"), "img-src data:") {
				t.Fatal("missing image privacy policy")
			}
		})
	}
	w := request(t, s, "GET", "/api/session?id="+url.QueryEscape(id), "", nil)
	var data struct {
		Entries []map[string]any `json:"entries"`
		Header  map[string]any   `json:"header"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Entries) != 3 || data.Header["name"] != "A local session" {
		t.Fatalf("unexpected API data: %+v", data)
	}
	w = request(t, s, "GET", "/session?id="+url.QueryEscape(id), "", nil)
	if strings.Contains(w.Body.String(), `id="share-btn"`) {
		t.Fatal("share button visible by default")
	}
	if !strings.Contains(w.Body.String(), `/export?id=`) || !strings.Contains(w.Body.String(), "new EventSource") {
		t.Fatal("live viewer lacks export or events")
	}
	s.sharingEnabled = true
	w = request(t, s, "GET", "/session?id="+url.QueryEscape(id), "", nil)
	if !strings.Contains(w.Body.String(), `id="share-btn"`) {
		t.Fatal("opt-in share button not visible")
	}
}

func TestExportIsOfflineAndDownloadable(t *testing.T) {
	s, id := testServer(t)
	w := request(t, s, "GET", "/export?id="+url.QueryEscape(id), "", nil)
	if got := w.Header().Get("Content-Disposition"); got != `attachment; filename=session.html` {
		t.Fatalf("disposition %q", got)
	}
	html := w.Body.String()
	for _, forbidden := range []string{"new EventSource", `id="share-btn"`, `class="viewer-actions"`, "{{SESSION_DATA}}", "{{CSS}}", "{{JS}}"} {
		if strings.Contains(html, forbidden) {
			t.Errorf("export contains %q", forbidden)
		}
	}
	start := strings.Index(html, `<script id="session-data" type="application/json">`)
	if start < 0 {
		t.Fatal("missing embedded session data")
	}
	encoded := strings.SplitN(strings.SplitN(html[start:], ">", 2)[1], "</script>", 2)[0]
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || !strings.Contains(string(decoded), "Keep this private") {
		t.Fatalf("export lost session data: %v", err)
	}
	if !strings.Contains(html, `http-equiv="Content-Security-Policy"`) {
		t.Fatal("missing standalone privacy policy")
	}
}

func TestEndpointMethodsAndErrors(t *testing.T) {
	s, id := testServer(t)
	for _, path := range []string{"/", "/session", "/api/session", "/export", "/events"} {
		w := request(t, s, "POST", path+"?id="+url.QueryEscape(id), "", nil)
		if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
			t.Errorf("POST %s status=%d", path, w.Code)
		}
	}
	for _, path := range []string{"/session", "/api/session", "/export", "/events"} {
		if w := request(t, s, "GET", path, "", nil); w.Code != 400 {
			t.Errorf("missing id %s status %d", path, w.Code)
		}
		if w := request(t, s, "GET", path+"?id=missing.jsonl", "", nil); w.Code != 404 {
			t.Errorf("missing session %s status %d", path, w.Code)
		}
	}
	if w := request(t, s, "GET", "/does-not-exist", "", nil); w.Code != 404 {
		t.Fatalf("unknown path status %d", w.Code)
	}
	if w := request(t, s, "HEAD", "/events?id="+url.QueryEscape(id), "", nil); w.Code != 200 {
		t.Fatalf("HEAD events status %d", w.Code)
	}
}

func TestPrivacyOriginAndHostGuards(t *testing.T) {
	s, _ := testServer(t)
	for _, headers := range []map[string]string{
		{"Origin": "https://evil.example"},
		{"Origin": "null"},
		{"Origin": "http://localhost:27183/"},
		{"Origin": "https://localhost:27183"},
		{"Origin": "http://localhost:27183@evil.example"},
		{"Sec-Fetch-Site": "cross-site"},
	} {
		if w := request(t, s, "GET", "/", "", headers); w.Code != 403 {
			t.Errorf("headers %+v status %d", headers, w.Code)
		}
	}
	if w := request(t, s, "GET", "/", "", map[string]string{"Origin": "http://localhost:27183"}); w.Code != 200 {
		t.Fatal("same origin rejected")
	}
	r := httptest.NewRequest("GET", "http://evil.example:27183/", nil)
	w := httptest.NewRecorder()
	s.handler().ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("loopback DNS rebinding host allowed")
	}
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "127.12.34.56"} {
		if !isLoopbackHost(host) {
			t.Errorf("loopback rejected: %s", host)
		}
	}
}

func TestSharingRequiresOptInAndExplicitSameOriginConfirmation(t *testing.T) {
	s, id := testServer(t)
	path := "/share?id=" + url.QueryEscape(id)
	if w := request(t, s, "GET", path, "", nil); w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatal("GET sharing accepted")
	}
	if w := request(t, s, "POST", path, `{"confirmed":true}`, nil); w.Code != 403 {
		t.Fatal("sharing enabled by default")
	}
	s.sharingEnabled = true
	for _, tc := range []struct {
		name, body string
		headers    map[string]string
		status     int
	}{
		{"missing origin", `{"confirmed":true}`, map[string]string{"X-Pi-Share": "1", "Content-Type": "application/json"}, 403},
		{"missing custom header", `{"confirmed":true}`, map[string]string{"Origin": "http://localhost:27183", "Content-Type": "application/json"}, 403},
		{"foreign origin", `{"confirmed":true}`, map[string]string{"Origin": "http://evil.example", "X-Pi-Share": "1", "Content-Type": "application/json"}, 403},
		{"wrong content type", `{"confirmed":true}`, map[string]string{"Origin": "http://localhost:27183", "X-Pi-Share": "1", "Content-Type": "text/plain"}, 415},
		{"not confirmed", `{"confirmed":false}`, nil, 400},
		{"missing confirmation", `{}`, nil, 400},
		{"unknown fields", `{"confirmed":true,"extra":1}`, nil, 400},
		{"invalid JSON", `{`, nil, 400},
		{"trailing JSON", `{"confirmed":true} {}`, nil, 400},
		{"too large", `{"confirmed":true,"extra":"` + strings.Repeat("x", 2048) + `"}`, nil, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := tc.headers
			if headers == nil {
				headers = map[string]string{"Origin": "http://localhost:27183", "X-Pi-Share": "1", "Content-Type": "application/json"}
			}
			w := request(t, s, "POST", path, tc.body, headers)
			if w.Code != tc.status {
				t.Fatalf("status %d want %d: %s", w.Code, tc.status, w.Body.String())
			}
		})
	}
	// Confirmed, nonexistent sessions fail before looking up or invoking gh.
	w := request(t, s, "POST", "/share?id=missing.jsonl", `{"confirmed":true}`, map[string]string{"Origin": "http://localhost:27183", "X-Pi-Share": "1", "Content-Type": "application/json"})
	if w.Code != 404 {
		t.Fatalf("unknown session: %d", w.Code)
	}
}

func TestDuplicateFilenamesHaveDistinctIDs(t *testing.T) {
	dir := t.TempDir()
	writeFixture(t, dir, "project-a", "same.jsonl", sampleSession)
	writeFixture(t, dir, "project-b", "same.jsonl", strings.ReplaceAll(sampleSession, "Keep this private", "Another project"))
	sessions, err := loadAllSessions(dir)
	if err != nil || len(sessions) != 2 {
		t.Fatalf("sessions %v, %v", sessions, err)
	}
	if sessions[0].ID == sessions[1].ID {
		t.Fatal("duplicate IDs")
	}
	for _, id := range []string{"project-a/same.jsonl", "project-b/same.jsonl"} {
		if _, err := findSession(dir, id); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if _, err := findSession(dir, "same.jsonl"); !errors.Is(err, errAmbiguousSession) {
		t.Fatalf("ambiguous legacy lookup: %v", err)
	}
	writeFixture(t, dir, "project-a", "unique.jsonl", sampleSession)
	if sess, err := findSession(dir, "unique.jsonl"); err != nil || sess.ID != "project-a/unique.jsonl" {
		t.Fatalf("unique legacy lookup: %+v, %v", sess, err)
	}
}

func TestTraversalAndSymlinksCannotExposeOutsideFiles(t *testing.T) {
	s, id := testServer(t)
	outside := t.TempDir()
	secret := writeFixture(t, outside, "private", "outside.jsonl", strings.ReplaceAll(sampleSession, "Keep this private", "OUTSIDE_SECRET"))
	project := strings.Split(id, "/")[0]
	if err := os.Symlink(secret, filepath.Join(s.sessionsDir, project, "leak.jsonl")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(filepath.Dir(secret), filepath.Join(s.sessionsDir, "symlink-project")); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{"../outside.jsonl", "../private/outside.jsonl", "/etc/passwd", `..\private\outside.jsonl`, project + "/../outside.jsonl", project + "/leak.jsonl", "symlink-project/outside.jsonl", project + "/\x00.jsonl", "."} {
		for _, endpoint := range []string{"/session", "/api/session", "/export"} {
			w := request(t, s, "GET", endpoint+"?id="+url.QueryEscape(candidate), "", nil)
			if w.Code != 404 || strings.Contains(w.Body.String(), "OUTSIDE_SECRET") {
				t.Errorf("unsafe candidate %q: %d", candidate, w.Code)
			}
		}
	}
	sessions, err := loadAllSessions(s.sessionsDir)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("symlink enumeration: %+v, %v", sessions, err)
	}
}

func TestMalformedJSONLAndMissingLeafDoNotPanic(t *testing.T) {
	dir := t.TempDir()
	contents := sampleSession + "null\n[]\n42\n{}\n{invalid json\n" + `{"type":"message","message":null}` + "\n" + `{"type":"model_change","id":42}` + "\n" + `{"type":"label"}` + "\n" + `{"type":"message","id":"partial"`
	path := writeFixture(t, dir, "project", "malformed.jsonl", contents)
	sess, err := parseSession(path, "project", "malformed.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	if len(sess.Entries) != 5 || sess.MessageCount != 2 || sess.TokenTotal != 123 {
		t.Fatalf("unexpected parsed session: %+v", sess)
	}
	if sess.LastActivity != "2026-01-01T10:02:00Z" {
		t.Fatalf("activity: %s", sess.LastActivity)
	}
	for _, entry := range sess.Entries {
		if entry == nil {
			t.Fatal("null entry retained")
		}
	}
	for _, sample := range []Session{sess, {Entries: []map[string]any{nil, {"id": 123}, {}}}, {}} {
		if html := generateExportHtml(sample, false); html == "" {
			t.Fatal("empty export")
		}
	}
	empty := parseSessionData(nil, "project", "empty.jsonl", time.Unix(10, 0))
	if empty.Entries == nil || empty.Header == nil || empty.LastActivity == "" {
		t.Fatalf("incomplete empty session: %+v", empty)
	}
}

func TestSessionNamePreservesUnicode(t *testing.T) {
	sess := Session{Entries: []map[string]any{{"type": "message", "message": map[string]any{"role": "user", "content": strings.Repeat("界", 100)}}}}
	name := sessionName(sess)
	if !utf8.ValidString(name) || len([]rune(name)) != 81 {
		t.Fatalf("invalid truncated name: %q", name)
	}
}

func TestSSEClientLifecycle(t *testing.T) {
	s, _ := testServer(t)
	client := s.addClient("a")
	other := s.addClient("b")
	s.broadcast("a", "reload")
	if got := <-client.ch; got != "reload" {
		t.Fatal(got)
	}
	select {
	case <-other.ch:
		t.Fatal("wrong session received event")
	default:
	}
	s.removeClient(client)
	s.removeClient(client)     // Repeated removal is harmless.
	s.broadcast("a", "reload") // Never send into a closed channel.
	if _, ok := <-client.ch; ok {
		t.Fatal("channel still open")
	}
	s.clientsMu.RLock()
	count := len(s.clients)
	s.clientsMu.RUnlock()
	if count != 1 {
		t.Fatalf("leaked clients: %d", count)
	}
	s.Close()
	s.Close()
	if _, ok := <-other.ch; ok {
		t.Fatal("close did not close other clients")
	}
	if _, ok := <-s.addClient("a").ch; ok {
		t.Fatal("new client accepted after close")
	}
}

func TestSSEConcurrentRemovalAndBroadcast(t *testing.T) {
	s, _ := testServer(t)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				c := s.addClient("session")
				s.broadcast("session", "reload")
				s.removeClient(c)
				s.removeClient(c)
			}
		}()
	}
	wg.Wait()
	s.clientsMu.RLock()
	count := len(s.clients)
	s.clientsMu.RUnlock()
	if count != 0 {
		t.Fatalf("clients leaked: %d", count)
	}
}

func TestSSEHTTPDisconnectCleansUp(t *testing.T) {
	s, id := testServer(t)
	httpServer := httptest.NewServer(s.handler())
	defer httpServer.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, "GET", httpServer.URL+"/events?id="+url.QueryEscape(id), nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := httpServer.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(response.Body)
	if line, err := reader.ReadString('\n'); err != nil || line != ":ok\n" {
		t.Fatalf("initial event: %q %v", line, err)
	}
	reader.ReadString('\n')
	s.broadcast(id, "reload")
	if line, err := reader.ReadString('\n'); err != nil || line != "data: reload\n" {
		t.Fatalf("broadcast: %q %v", line, err)
	}
	cancel()
	response.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.clientsMu.RLock()
		count := len(s.clients)
		s.clientsMu.RUnlock()
		if count == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("SSE client not removed after disconnect")
		}
		time.Sleep(time.Millisecond)
	}
	s.broadcast(id, "reload")
}

func TestSSEWatcherUsesProjectQualifiedIDs(t *testing.T) {
	dir := t.TempDir()
	fileA := writeFixture(t, dir, "a", "same.jsonl", sampleSession)
	writeFixture(t, dir, "b", "same.jsonl", sampleSession)
	// No background watcher here, to deterministically inspect one scan at a time.
	s := &server{sessionsDir: dir, fileMod: make(map[string]fileStamp), done: make(chan struct{})}
	s.scanFiles()
	a := s.addClient("a/same.jsonl")
	defer s.removeClient(a)
	b := s.addClient("b/same.jsonl")
	defer s.removeClient(b)
	f, err := os.OpenFile(fileA, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintln(f, `{"type":"label","id":"new","label":"updated"}`)
	f.Close()
	s.scanFiles()
	select {
	case <-a.ch:
	default:
		t.Fatal("file modification not broadcast")
	}
	select {
	case <-b.ch:
		t.Fatal("same filename in different project received update")
	default:
	}
}

func TestSSEWatcherNotifiesNewFileSubscriberOnFirstScan(t *testing.T) {
	dir := t.TempDir()
	// Deliberately omit the background watcher: reproduce the exact ordering
	// without sleeps or relying on a race with its 1.5-second ticker.
	s := &server{sessionsDir: dir, fileMod: make(map[string]fileStamp), done: make(chan struct{})}
	path := writeFixture(t, dir, "new-project", "new-session.jsonl", sampleSession)
	initial, err := findSession(dir, "new-project/new-session.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	client := s.addClient(initial.ID)
	defer s.removeClient(client)

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintln(file, `{"type":"message","id":"before-first-scan","parentId":"assistant-1","message":{"role":"user","content":"Do not miss this append"}}`)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, known := s.fileMod[initial.ID]; known {
		t.Fatal("fixture already present in watcher baseline")
	}

	s.scanFiles()
	select {
	case event := <-client.ch:
		if event != "reload" {
			t.Fatalf("unexpected event: %q", event)
		}
	default:
		t.Fatal("new session append was missed on the first watcher scan")
	}
	updated, err := findSession(dir, initial.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Entries) != len(initial.Entries)+1 || lastLeafID(updated.Entries) != "before-first-scan" {
		t.Fatal("reloaded session does not include the missed append")
	}
	// An unchanged file must not emit an endless stream of refresh events.
	s.scanFiles()
	select {
	case event := <-client.ch:
		t.Fatalf("unchanged file emitted %q", event)
	default:
	}
}

func TestHeaderFilenameCannotInjectHTTPHeaders(t *testing.T) {
	s, _ := testServer(t)
	name := "unsafe\"\r\nX-Injected: yes.jsonl"
	writeFixture(t, s.sessionsDir, "odd", name, sampleSession)
	w := request(t, s, "GET", "/export?id="+url.QueryEscape("odd/"+name), "", nil)
	if w.Code != 200 || w.Header().Get("X-Injected") != "" {
		t.Fatalf("header injection: status %d %+v", w.Code, w.Header())
	}
	if strings.ContainsAny(w.Header().Get("Content-Disposition"), "\r\n") {
		t.Fatal("raw newline in content disposition")
	}
}

func TestNoRawTranscriptInHTML(t *testing.T) {
	session := parseSessionData([]byte(`{"type":"message","id":"x","message":{"role":"user","content":"</script><script>alert(1)</script>"}}`), "project", "x.jsonl", time.Now())
	html := generateExportHtml(session, false)
	if strings.Contains(html, "</script><script>alert(1)</script>") {
		t.Fatal("transcript inserted into raw script context")
	}
}

func TestSSEUnsupportedWriter(t *testing.T) {
	s, id := testServer(t)
	w := &noFlushWriter{header: make(http.Header)}
	r := httptest.NewRequest("GET", "http://localhost/events?id="+url.QueryEscape(id), nil)
	s.handleEvents(w, r)
	if w.status != 500 {
		t.Fatalf("status %d", w.status)
	}
}

type noFlushWriter struct {
	header http.Header
	status int
}

func (w *noFlushWriter) Header() http.Header         { return w.header }
func (w *noFlushWriter) WriteHeader(status int)      { w.status = status }
func (w *noFlushWriter) Write(p []byte) (int, error) { return io.Discard.Write(p) }

func TestLastLeafIDSkipsHeaderAndMalformedIDs(t *testing.T) {
	for _, tc := range []struct {
		entries []map[string]any
		want    string
	}{
		{nil, ""},
		{[]map[string]any{{"type": "session", "id": "header"}}, ""},
		{[]map[string]any{{"type": "message", "id": "last"}, nil, {"id": 42}, {"id": ""}}, "last"},
	} {
		if got := lastLeafID(tc.entries); got != tc.want {
			t.Errorf("leaf=%q want %q", got, tc.want)
		}
	}
}

func FuzzParseSessionExport(f *testing.F) {
	for _, seed := range []string{sampleSession, "null\n", "{invalid", `{"type":"message","message":{}}`, `{"type":"model_change","id":42}`} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, contents string) {
		if len(contents) > 1<<20 {
			t.Skip()
		}
		sess := parseSessionData([]byte(contents), "project", "fuzz.jsonl", time.Unix(0, 0))
		_ = generateExportHtml(sess, false)
		_ = sessionName(sess)
	})
}
