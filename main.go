package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html/template"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "embed"
)

const defaultPort = "27183"

// Set by release builds with -ldflags. Development builds remain identifiable.
var version = "dev"
var commit = "unknown"
var buildDate = "unknown"

const contentSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

//go:embed templates/template.html
var templateHtml string

//go:embed templates/template.css
var templateCss string

//go:embed templates/template.js
var templateJs string

//go:embed templates/vendor/marked.min.js
var markedJs string

//go:embed templates/vendor/highlight.min.js
var hljsJs string

// ── Live-reload: fetch JSON, diff, append new entries ──────────────────────
const liveReloadJs = `
<script>
(function() {
  var params = new URLSearchParams(location.search);
  var sessId = params.get('id') || '';
  var branchPaused = params.has('leafId') || params.has('targetId');
  var FOLLOW = !branchPaused;
  var followBtn = null;
  var pendingCount = 0;
  var latestData = null;
  var loading = false;
  var queued = false;
  var es = null;
  var status = document.createElement('span');
  status.className = 'viewer-live';
  status.setAttribute('role', 'status');
  status.title = 'Local changes update automatically. No transcript is uploaded.';
  status.textContent = 'Connecting';
  var actions = document.querySelector('.viewer-actions');
  if (actions) actions.prepend(status);

  function escapeHtml(t) {
    var d = document.createElement('div');
    d.textContent = String(t == null ? '' : t);
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isAtBottom() {
    var content = document.getElementById('content');
    if (content && content.scrollHeight > content.clientHeight) {
      return content.scrollHeight - content.scrollTop - content.clientHeight < 80;
    }
    return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 80;
  }
  function scrollToBottom() {
    var content = document.getElementById('content');
    if (content) content.scrollTop = content.scrollHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
  function hideFollowButton() {
    if (followBtn) followBtn.remove();
    followBtn = null;
  }
  function showFollowButton() {
    if (!followBtn) {
      followBtn = document.createElement('button');
      followBtn.className = 'viewer-follow';
      followBtn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:200;padding:9px 15px;font:inherit;background:var(--accent);color:var(--body-bg);border:none;border-radius:8px;cursor:pointer;box-shadow:0 3px 16px rgba(0,0,0,.15);';
      document.body.appendChild(followBtn);
      followBtn.addEventListener('click', function() {
        branchPaused = false;
        FOLLOW = true;
        pendingCount = 0;
        if (latestData && typeof window.updateSessionData === 'function') {
          window.updateSessionData(latestData, {follow:true, forceLatest:true, scrollToBottom:true});
        } else { scrollToBottom(); }
        hideFollowButton();
      });
    }
    followBtn.textContent = pendingCount ? '↓ '+pendingCount+' new · Follow latest' : '↓ Follow latest';
  }
  function onScroll() {
    if (branchPaused) return;
    FOLLOW = isAtBottom();
    if (FOLLOW) { pendingCount = 0; hideFollowButton(); }
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  var content = document.getElementById('content');
  if (content) content.addEventListener('scroll', onScroll, {passive:true});
  var tree = document.getElementById('tree-container');
  if (tree) tree.addEventListener('click', function(e) {
    if (e.target.closest('.tree-node')) {
      branchPaused = true;
      FOLLOW = false;
      showFollowButton();
    }
  });
  if (FOLLOW) scrollToBottom();

  function refresh() {
    if (loading) { queued = true; return; }
    loading = true;
    fetch('/api/session?id='+encodeURIComponent(sessId), {cache:'no-store'})
      .then(function(r) {
        if (!r.ok) throw new Error(r.status === 404 ? 'Session unavailable' : 'Update failed');
        return r.json();
      })
      .then(function(data) {
        if (typeof window.updateSessionData !== 'function') throw new Error('Reload page to update');
        latestData = data;
        var result = window.updateSessionData(data, {follow:FOLLOW, scrollToBottom:FOLLOW}) || {};
        if (!FOLLOW && result.added > 0) {
          pendingCount += result.added;
          showFollowButton();
        }
        status.textContent = 'Live';
      })
      .catch(function(err) { status.textContent = err.message || 'Update failed'; })
      .finally(function() {
        loading = false;
        if (queued) { queued = false; refresh(); }
      });
  }
  function connect() {
    if (es) es.close();
    es = new EventSource('/events?id='+encodeURIComponent(sessId));
    es.onopen = function() { status.textContent = 'Live'; refresh(); };
    es.onmessage = function(e) { if (e.data === 'reload') refresh(); };
    es.onerror = function() { status.textContent = 'Reconnecting'; };
  }
  connect();
  window.addEventListener('pagehide', function() { if (es) es.close(); });
  window.addEventListener('pageshow', function(e) { if (e.persisted) connect(); });

  // ── Share button ────────────────────────────────────────────────────────
  var shareBtn = document.getElementById('share-btn');
  var shareOverlay = null;

  function showShareResult(gistUrl, previewUrl) {
    if (shareOverlay) shareOverlay.remove();
    shareOverlay = document.createElement('div');
    shareOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--container-bg);border:1px solid var(--dim);border-radius:4px;padding:calc(var(--line-height)*2);max-width:500px;width:90%;font-family:inherit;';
    box.innerHTML = '<h3 style="margin:0 0 var(--line-height);font-size:12px;color:var(--border-accent);">Session Shared</h3>' +
      '<div style="margin-bottom:var(--line-height);"><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:4px;">Gist URL</label>' +
      '<input readonly value="'+escapeHtml(gistUrl)+'" style="width:100%;padding:4px 8px;font-size:11px;font-family:inherit;background:var(--body-bg);color:var(--text);border:1px solid var(--dim);border-radius:3px;cursor:pointer;" onclick="this.select()"></div>' +
      '<div style="margin-bottom:var(--line-height);"><label style="display:block;font-size:11px;color:var(--muted);margin-bottom:4px;">Preview URL</label>' +
      '<input readonly value="'+escapeHtml(previewUrl)+'" style="width:100%;padding:4px 8px;font-size:11px;font-family:inherit;background:var(--body-bg);color:var(--text);border:1px solid var(--dim);border-radius:3px;cursor:pointer;" onclick="this.select()"></div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
      '<button id="share-copy-gist" style="padding:4px 10px;font-size:11px;font-family:inherit;background:var(--accent);color:var(--body-bg);border:none;border-radius:3px;cursor:pointer;">Copy Gist</button>' +
      '<button id="share-copy-preview" style="padding:4px 10px;font-size:11px;font-family:inherit;background:var(--container-bg);color:var(--text);border:1px solid var(--dim);border-radius:3px;cursor:pointer;">Copy Preview</button>' +
      '<button id="share-close" style="padding:4px 10px;font-size:11px;font-family:inherit;background:var(--container-bg);color:var(--text);border:1px solid var(--dim);border-radius:3px;cursor:pointer;">Close</button></div>';
    shareOverlay.appendChild(box);
    document.body.appendChild(shareOverlay);

    shareOverlay.addEventListener('click', function(e) {
      if (e.target === shareOverlay) { shareOverlay.remove(); shareOverlay = null; }
    });
    document.getElementById('share-close').addEventListener('click', function() {
      shareOverlay.remove(); shareOverlay = null;
    });
    document.getElementById('share-copy-gist').addEventListener('click', function() {
      navigator.clipboard.writeText(gistUrl).catch(function(){});
      this.textContent = 'Copied!';
      setTimeout(function(){ var button=document.getElementById('share-copy-gist'); if(button) button.textContent='Copy Gist'; }, 1200);
    });
    document.getElementById('share-copy-preview').addEventListener('click', function() {
      navigator.clipboard.writeText(previewUrl).catch(function(){});
      this.textContent = 'Copied!';
      setTimeout(function(){ var button=document.getElementById('share-copy-preview'); if(button) button.textContent='Copy Preview'; }, 1200);
    });
  }

  function showShareError(msg) {
    if (shareOverlay) shareOverlay.remove();
    shareOverlay = document.createElement('div');
    shareOverlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:300;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;';
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--container-bg);border:1px solid var(--error);border-radius:4px;padding:calc(var(--line-height)*2);max-width:400px;width:90%;font-family:inherit;';
    box.innerHTML = '<h3 style="margin:0 0 var(--line-height);font-size:12px;color:var(--error);">Share Failed</h3>' +
      '<p style="font-size:11px;color:var(--text);margin:0 0 var(--line-height);white-space:pre-wrap;">'+escapeHtml(msg)+'</p>' +
      '<div style="display:flex;justify-content:flex-end;"><button id="share-close-err" style="padding:4px 10px;font-size:11px;font-family:inherit;background:var(--container-bg);color:var(--text);border:1px solid var(--dim);border-radius:3px;cursor:pointer;">Close</button></div>';
    shareOverlay.appendChild(box);
    document.body.appendChild(shareOverlay);
    document.getElementById('share-close-err').addEventListener('click', function() {
      shareOverlay.remove(); shareOverlay = null;
    });
    shareOverlay.addEventListener('click', function(e) {
      if (e.target === shareOverlay) { shareOverlay.remove(); shareOverlay = null; }
    });
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', function() {
      if (!window.confirm('Upload this entire session to GitHub as a secret Gist?\n\nIt includes messages, code, tool output, paths and attached images, which may contain credentials or personal information. Secret Gists are unlisted, NOT private: anyone with the link can read them. Review the local export first.\n\nChoose OK only if you want to upload now.')) return;
      shareBtn.textContent = '...';
      shareBtn.disabled = true;
      fetch('/share?id=' + encodeURIComponent(sessId), {method:'POST', headers:{'Content-Type':'application/json', 'X-Pi-Share':'1'}, body:JSON.stringify({confirmed:true})})
        .then(function(r){ return r.json(); })
        .then(function(data) {
          shareBtn.textContent = '↗ Share';
          shareBtn.disabled = false;
          if (data.error) {
            showShareError(data.error + (data.stderr ? '\n\n' + data.stderr : ''));
          } else {
            showShareResult(data.gistUrl, data.previewUrl);
          }
        })
        .catch(function(err) {
          shareBtn.textContent = '↗ Share';
          shareBtn.disabled = false;
          showShareError(err.message || 'Network error');
        });
    });
  }
})();
</script>
`

func main() {
	port := flag.String("p", defaultPort, "port to listen on")
	host := flag.String("host", "127.0.0.1", "address to bind (non-loopback exposes private sessions without authentication)")
	open := flag.Bool("o", false, "auto-open browser")
	home, _ := os.UserHomeDir()
	sessionsDir := flag.String("sessions-dir", filepath.Join(home, ".pi", "agent", "sessions"), "directory containing project session folders")
	sharing := flag.Bool("enable-sharing", false, "enable explicitly confirmed GitHub secret Gist uploads (requires gh)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Printf("pi-sessions-viewer %s (commit %s, built %s)\n", version, commit, buildDate)
		return
	}
	if flag.NArg() != 0 || *host == "" {
		fmt.Fprintln(os.Stderr, "unexpected arguments or empty -host; use -help for usage")
		os.Exit(2)
	}
	info, err := os.Stat(*sessionsDir)
	if err != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "sessions directory unavailable: %s\nUse -sessions-dir to select an existing directory.\n", *sessionsDir)
		os.Exit(1)
	}
	srv := newServer(*sessionsDir)
	defer srv.Close()
	srv.bindHost = *host
	srv.sharingEnabled = *sharing
	addr := net.JoinHostPort(*host, *port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot listen on %s: %v\n", addr, err)
		os.Exit(1)
	}
	browserHost := *host
	if browserHost == "0.0.0.0" || browserHost == "::" {
		browserHost = "127.0.0.1"
	}
	_, actualPort, _ := net.SplitHostPort(listener.Addr().String())
	browserURL := "http://" + net.JoinHostPort(browserHost, actualPort)
	fmt.Printf("Pi Sessions Viewer %s → %s\n   Serving from: %s\n", version, browserURL, *sessionsDir)
	if !isLoopbackHost(*host) {
		fmt.Fprintln(os.Stderr, "WARNING: non-loopback binding exposes session contents without authentication. Use only a trusted network or protected tunnel.")
	}
	if *sharing {
		fmt.Println("   GitHub sharing enabled: each upload requires explicit confirmation.")
	}
	if *open {
		go openBrowser(browserURL)
	}
	httpServer := &http.Server{Handler: srv.handler(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		srv.Close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			httpServer.Close()
		}
	}()
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		os.Exit(1)
	}
	<-shutdownDone
}

func openBrowser(url string) {
	var cmd string
	var args []string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
		args = []string{url}
	case "windows":
		cmd = "cmd"
		args = []string{"/c", "start", url}
	default:
		cmd = "xdg-open"
		args = []string{url}
	}
	if err := exec.Command(cmd, args...).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "could not open browser; open %s manually\n", url)
	}
}

// ── Server with live-reload SSE ────────────────────────────────────────────

type sseClient struct {
	ch     chan string
	sessID string
}

type fileStamp struct {
	modified time.Time
	size     int64
}

type server struct {
	sessionsDir    string
	bindHost       string
	sharingEnabled bool
	clients        []*sseClient
	clientsMu      sync.RWMutex
	fileMod        map[string]fileStamp
	done           chan struct{}
	watchDone      chan struct{}
	closeOnce      sync.Once
}

func newServer(sessionsDir string) *server {
	s := &server{sessionsDir: sessionsDir, bindHost: "127.0.0.1", fileMod: make(map[string]fileStamp), done: make(chan struct{}), watchDone: make(chan struct{})}
	go s.watchFiles()
	return s
}

func (s *server) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		<-s.watchDone
		s.clientsMu.Lock()
		defer s.clientsMu.Unlock()
		for _, c := range s.clients {
			close(c.ch)
		}
		s.clients = nil
	})
}

func (s *server) addClient(sessID string) *sseClient {
	c := &sseClient{ch: make(chan string, 4), sessID: sessID}
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	select {
	case <-s.done:
		close(c.ch)
	default:
		s.clients = append(s.clients, c)
	}
	return c
}

func (s *server) removeClient(target *sseClient) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()
	for i, c := range s.clients {
		if c == target {
			s.clients = append(s.clients[:i], s.clients[i+1:]...)
			close(c.ch)
			return
		}
	}
}

func (s *server) broadcast(sessID, msg string) {
	s.clientsMu.RLock()
	defer s.clientsMu.RUnlock()
	for _, c := range s.clients {
		if c.sessID == sessID {
			select {
			case c.ch <- msg:
			default:
			}
		}
	}
}

func (s *server) watchFiles() {
	defer close(s.watchDone)
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()
	s.scanFiles()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.scanFiles()
		}
	}
}

func (s *server) scanFiles() {
	root, err := os.OpenRoot(s.sessionsDir)
	if err != nil {
		return
	}
	defer root.Close()
	projects, err := os.ReadDir(s.sessionsDir)
	if err != nil {
		return
	}
	next := make(map[string]fileStamp)
	for _, project := range projects {
		if !project.IsDir() || project.Type()&os.ModeSymlink != 0 {
			continue
		}
		dir, err := root.Open(project.Name())
		if err != nil {
			continue
		}
		files, err := dir.ReadDir(-1)
		dir.Close()
		if err != nil {
			continue
		}
		for _, file := range files {
			if !file.Type().IsRegular() || !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}
			id := project.Name() + "/" + file.Name()
			info, err := root.Lstat(id)
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			stamp := fileStamp{info.ModTime(), info.Size()}
			next[id] = stamp
			if before, known := s.fileMod[id]; known && before != stamp {
				s.broadcast(id, "reload")
			}
		}
	}
	for id := range s.fileMod {
		if _, exists := next[id]; !exists {
			s.broadcast(id, "reload")
		}
	}
	s.fileMod = next
}

// The local server deliberately has no authentication. Prevent browser-origin
// access and DNS rebinding to the default loopback listener.
func isLoopbackHost(host string) bool {
	return strings.EqualFold(host, "localhost") || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/session", s.handleSession)
	mux.HandleFunc("/api/session", s.handleApiSession)
	mux.HandleFunc("/export", s.handleExport)
	mux.HandleFunc("/share", s.handleShare)
	mux.HandleFunc("/events", s.handleEvents)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		if isLoopbackHost(s.bindHost) && !isLoopbackHost(host) {
			http.Error(w, "unrecognized host for local listener", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(r, origin) {
			http.Error(w, "cross-origin access denied", http.StatusForbidden)
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "cross-site access denied", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func sameOrigin(r *http.Request, origin string) bool {
	u, err := url.Parse(origin)
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return err == nil && u.Scheme == scheme && u.Host == r.Host && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

func allowRead(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return true
	}
	w.Header().Set("Allow", "GET, HEAD")
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

func writeJSONError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (s *server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if !allowRead(w, r) {
		return
	}
	sessions, err := loadAllSessions(s.sessionsDir)
	if err != nil {
		http.Error(w, "unable to read sessions directory", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := indexTmpl.Execute(w, sessions); err != nil {
		fmt.Fprintf(os.Stderr, "template error: %v\n", err)
	}
}

func (s *server) requestedSession(w http.ResponseWriter, r *http.Request) (Session, bool) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeJSONError(w, http.StatusBadRequest, "missing id")
		return Session{}, false
	}
	sess, err := findSession(s.sessionsDir, id)
	if err != nil {
		status := http.StatusNotFound
		if errors.Is(err, errAmbiguousSession) {
			status = http.StatusConflict
		}
		writeJSONError(w, status, err.Error())
		return Session{}, false
	}
	return sess, true
}

func (s *server) handleSession(w http.ResponseWriter, r *http.Request) {
	if !allowRead(w, r) {
		return
	}
	sess, ok := s.requestedSession(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(generateExportHtml(sess, true, s.sharingEnabled)))
}

func (s *server) handleApiSession(w http.ResponseWriter, r *http.Request) {
	if !allowRead(w, r) {
		return
	}
	sess, ok := s.requestedSession(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]any{"header": sess.Header, "entries": sess.Entries, "leafId": lastLeafID(sess.Entries)})
}

func (s *server) handleExport(w http.ResponseWriter, r *http.Request) {
	if !allowRead(w, r) {
		return
	}
	sess, ok := s.requestedSession(w, r)
	if !ok {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": strings.TrimSuffix(sess.Filename, ".jsonl") + ".html"}))
	w.Write([]byte(generateExportHtml(sess, false)))
}

func findGh() string {
	candidates := []string{
		"/opt/homebrew/bin/gh",
		"/usr/local/bin/gh",
		"/usr/bin/gh",
		"/bin/gh",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	// Fallback to PATH lookup
	if p, err := exec.LookPath("gh"); err == nil {
		return p
	}
	return ""
}

func (s *server) handleShare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSONError(w, http.StatusMethodNotAllowed, "sharing requires POST")
		return
	}
	if !s.sharingEnabled {
		writeJSONError(w, http.StatusForbidden, "sharing is disabled; restart with -enable-sharing to opt in")
		return
	}
	if !sameOrigin(r, r.Header.Get("Origin")) || r.Header.Get("X-Pi-Share") != "1" {
		writeJSONError(w, http.StatusForbidden, "same-origin confirmation required")
		return
	}
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		writeJSONError(w, http.StatusUnsupportedMediaType, "JSON confirmation required")
		return
	}
	var confirmation struct {
		Confirmed bool `json:"confirmed"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&confirmation); err != nil || !confirmation.Confirmed {
		writeJSONError(w, http.StatusBadRequest, "explicit upload confirmation required")
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeJSONError(w, http.StatusBadRequest, "invalid confirmation")
		return
	}
	sess, ok := s.requestedSession(w, r)
	if !ok {
		return
	}
	ghPath := findGh()
	if ghPath == "" {
		writeJSONError(w, http.StatusBadRequest, "GitHub CLI (gh) not installed. Install from https://cli.github.com/")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, ghPath, "auth", "status").Run(); err != nil {
		writeJSONError(w, http.StatusBadRequest, "GitHub CLI not logged in. Run 'gh auth login' first.")
		return
	}
	tmpDir, err := os.MkdirTemp("", "pi-share-*")
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to create temporary export")
		return
	}
	defer os.RemoveAll(tmpDir)
	tmpFile := filepath.Join(tmpDir, "session.html")
	if err := os.WriteFile(tmpFile, []byte(generateExportHtml(sess, false)), 0600); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "failed to write temporary export")
		return
	}
	// gh creates secret (unlisted, not private) Gists by default.
	out, err := exec.CommandContext(ctx, ghPath, "gist", "create", "--", tmpFile).Output()
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "GitHub did not confirm the upload. Check your Gists before retrying to avoid duplicates.")
		return
	}
	gistURL := strings.TrimSpace(string(out))
	u, err := url.Parse(gistURL)
	if err != nil || u.Scheme != "https" || u.Host != "gist.github.com" {
		writeJSONError(w, http.StatusBadGateway, "upload returned an unexpected response; check your GitHub Gists")
		return
	}
	gistID := filepath.Base(u.Path)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(map[string]any{"gistUrl": gistURL, "gistId": gistID, "previewUrl": "https://pi.dev/session/#" + gistID})
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if !allowRead(w, r) {
		return
	}
	sess, ok := s.requestedSession(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	client := s.addClient(sess.ID)
	defer s.removeClient(client)
	fmt.Fprint(w, ":ok\n\n")
	flusher.Flush()
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case msg, open := <-client.ch:
			if !open {
				return
			}
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ":keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		case <-s.done:
			return
		}
	}
}

// ── Session data model ─────────────────────────────────────────────────────

type Session struct {
	ID           string
	Filename     string
	Project      string
	LastActivity string
	MessageCount int
	TokenTotal   int
	CostTotal    float64
	Header       map[string]any
	Entries      []map[string]any
}

// ── Loading ────────────────────────────────────────────────────────────────

var errSessionNotFound = errors.New("session not found")
var errAmbiguousSession = errors.New("ambiguous filename; open this session from the dashboard")

func validSessionPart(part string) bool {
	return part != "" && part != "." && part != ".." && !strings.ContainsAny(part, "/\\\x00")
}

func readRootSession(root *os.Root, project, filename string) (Session, error) {
	if !validSessionPart(project) || !validSessionPart(filename) || !strings.HasSuffix(filename, ".jsonl") {
		return Session{}, errSessionNotFound
	}
	projectInfo, err := root.Lstat(project)
	if err != nil || !projectInfo.IsDir() {
		return Session{}, errSessionNotFound
	}
	path := project + "/" + filename
	info, err := root.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return Session{}, errSessionNotFound
	}
	file, err := root.Open(path)
	if err != nil {
		return Session{}, errSessionNotFound
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return Session{}, errSessionNotFound
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return Session{}, errSessionNotFound
	}
	return parseSessionData(data, project, filename, info.ModTime()), nil
}

func findSession(dir, id string) (Session, error) {
	parts := strings.Split(id, "/")
	if len(parts) == 2 {
		root, err := os.OpenRoot(dir)
		if err != nil {
			return Session{}, errSessionNotFound
		}
		defer root.Close()
		return readRootSession(root, parts[0], parts[1])
	}
	// Retain old bookmarks only when the filename uniquely identifies a session.
	if len(parts) != 1 || !validSessionPart(id) || !strings.HasSuffix(id, ".jsonl") {
		return Session{}, errSessionNotFound
	}
	sessions, err := loadAllSessions(dir)
	if err != nil {
		return Session{}, errSessionNotFound
	}
	var found *Session
	for i := range sessions {
		if sessions[i].Filename == id {
			if found != nil {
				return Session{}, errAmbiguousSession
			}
			found = &sessions[i]
		}
	}
	if found == nil {
		return Session{}, errSessionNotFound
	}
	return *found, nil
}

func loadAllSessions(dir string) ([]Session, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sessions := make([]Session, 0)
	for _, e := range entries {
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		subDir, err := root.Open(e.Name())
		if err != nil {
			continue
		}
		files, err := subDir.ReadDir(-1)
		subDir.Close()
		if err != nil {
			continue
		}
		for _, file := range files {
			if !file.Type().IsRegular() || !strings.HasSuffix(file.Name(), ".jsonl") {
				continue
			}
			sess, err := readRootSession(root, e.Name(), file.Name())
			if err == nil {
				sessions = append(sessions, sess)
			}
		}
	}
	sort.Slice(sessions, func(i, j int) bool {
		ti, _ := time.Parse(time.RFC3339Nano, sessions[i].LastActivity)
		tj, _ := time.Parse(time.RFC3339Nano, sessions[j].LastActivity)
		if ti.Equal(tj) {
			return sessions[i].ID < sessions[j].ID
		}
		return ti.After(tj)
	})
	return sessions, nil
}

func parseSession(path, dirName, fileName string) (Session, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Session{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return Session{}, err
	}
	return parseSessionData(data, dirName, fileName, info.ModTime()), nil
}

func parseSessionData(data []byte, dirName, fileName string, modified time.Time) Session {
	sess := Session{ID: dirName + "/" + fileName, Filename: fileName, Project: cleanProjectName(dirName), Header: make(map[string]any), Entries: make([]map[string]any, 0)}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var raw map[string]any
		if err := json.Unmarshal([]byte(line), &raw); err != nil || raw == nil {
			continue
		}
		kind, ok := raw["type"].(string)
		if !ok || kind == "" {
			continue
		}
		if kind == "message" {
			if msg, ok := raw["message"].(map[string]any); !ok || msg == nil {
				continue
			}
		}
		sess.Entries = append(sess.Entries, raw)
		if kind == "session" {
			sess.Header = raw
		}
		if ts, ok := raw["timestamp"].(string); ok {
			if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
				last, _ := time.Parse(time.RFC3339Nano, sess.LastActivity)
				if t.After(last) {
					sess.LastActivity = ts
				}
			}
		}
		if kind == "message" {
			msg := raw["message"].(map[string]any)
			sess.MessageCount++
			if usage, ok := msg["usage"].(map[string]any); ok {
				if n, ok := usage["totalTokens"].(float64); ok && n > 0 && n < 1e15 {
					sess.TokenTotal += int(n)
				}
				if cost, ok := usage["cost"].(map[string]any); ok {
					if total, ok := cost["total"].(float64); ok && total > 0 {
						sess.CostTotal += total
					}
				}
			}
		}
	}
	if sess.LastActivity == "" {
		sess.LastActivity = modified.Format(time.RFC3339Nano)
	}
	return sess
}

func cleanProjectName(dirName string) string {
	s := strings.TrimPrefix(dirName, "--")
	s = strings.TrimSuffix(s, "--")
	s = strings.ReplaceAll(s, "--", "/")
	return s
}

// ── HTML Export Generation (replicates pi's /export exactly) ───────────────

func lastLeafID(entries []map[string]any) string {
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i]["type"] == "session" {
			continue
		}
		if id, ok := entries[i]["id"].(string); ok && id != "" {
			return id
		}
	}
	return ""
}

func generateExportHtml(session Session, showButtons bool, sharing ...bool) string {
	leafID := lastLeafID(session.Entries)

	sessionData := map[string]any{
		"header":        session.Header,
		"entries":       session.Entries,
		"leafId":        leafID,
		"systemPrompt":  nil,
		"tools":         nil,
		"renderedTools": nil,
	}

	dataJSON, _ := json.Marshal(sessionData)
	dataBase64 := base64.StdEncoding.EncodeToString(dataJSON)

	themeVars := generateThemeVars()
	bodyBg := "#18181e"
	cardBg := "#1e1e24"
	infoBg := "#3c3728"

	css := templateCss
	css = strings.Replace(css, "{{THEME_VARS}}", themeVars, 1)
	css = strings.Replace(css, "{{BODY_BG}}", bodyBg, 1)
	css = strings.Replace(css, "{{CONTAINER_BG}}", cardBg, 1)
	css = strings.Replace(css, "{{INFO_BG}}", infoBg, 1)

	html := templateHtml
	html = strings.Replace(html, "{{CSS}}", css, 1)
	html = strings.Replace(html, "{{JS}}", templateJs, 1)
	html = strings.Replace(html, "{{SESSION_DATA}}", dataBase64, 1)
	html = strings.Replace(html, "{{MARKED_JS}}", markedJs, 1)
	html = strings.Replace(html, "{{HIGHLIGHT_JS}}", hljsJs, 1)

	// A downloaded export stays self-contained and cannot load remote images.
	html = strings.Replace(html, "<head>", `<head><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="`+strings.ReplaceAll(contentSecurityPolicy, "; frame-ancestors 'none'", "")+`">`, 1)
	if showButtons {
		btns := `<nav class="viewer-actions" aria-label="Session actions"><a class="viewer-action" href="/" title="Back to sessions">← Sessions</a><a class="viewer-action" href="/export?id=` + template.HTMLEscapeString(url.QueryEscape(session.ID)) + `" download title="Download a self-contained HTML file. Nothing is uploaded.">↓ Export HTML</a>`
		if len(sharing) > 0 && sharing[0] {
			btns += `<button class="viewer-action" id="share-btn" title="Upload the full transcript to a secret GitHub Gist">↗ Share</button>`
		}
		btns += `</nav>`
		html = strings.Replace(html, "<body>", "<body>"+btns, 1)
		html = strings.Replace(html, "</body>", liveReloadJs+"</body>", 1)
	}

	return html
}

func generateThemeVars() string {
	vars := map[string]string{
		"cyan": "#00d7ff", "blue": "#5f87ff", "green": "#b5bd68", "red": "#cc6666",
		"yellow": "#ffff00", "gray": "#808080", "dimGray": "#666666", "darkGray": "#505050",
		"accent": "#8abeb7", "selectedBg": "#3a3a4a", "userMessageBg": "#343541",
		"toolPendingBg": "#282832", "toolSuccessBg": "#283228", "toolErrorBg": "#3c2828",
		"customMessageBg": "#2d2838", "customMessageLabel": "#9575cd", "thinkingText": "#808080",
		"mdHeading": "#f0c674", "mdLink": "#81a2be", "mdLinkUrl": "#666666",
		"mdCode": "#8abeb7", "mdCodeBlock": "#b5bd68", "mdCodeBlockBorder": "#808080",
		"mdQuote": "#808080", "mdQuoteBorder": "#808080", "mdHr": "#808080",
		"mdListBullet": "#8abeb7", "toolDiffAdded": "#b5bd68", "toolDiffRemoved": "#cc6666",
		"toolDiffContext": "#808080", "syntaxComment": "#6A9955", "syntaxKeyword": "#569CD6",
		"syntaxFunction": "#DCDCAA", "syntaxVariable": "#9CDCFE", "syntaxString": "#CE9178",
		"syntaxNumber": "#B5CEA8", "syntaxType": "#4EC9B0", "syntaxOperator": "#D4D4D4",
		"syntaxPunctuation": "#D4D4D4", "thinkingOff": "#505050", "thinkingMinimal": "#6e6e6e",
		"thinkingLow": "#5f87af", "thinkingMedium": "#81a2be", "thinkingHigh": "#b294bb",
		"thinkingXhigh": "#d183e8", "bashMode": "#b5bd68", "success": "#b5bd68",
		"error": "#cc6666", "warning": "#ffff00", "muted": "#808080", "dim": "#666666",
		"text": "#c9d1d9", "border": "#5f87ff", "borderAccent": "#00d7ff", "borderMuted": "#505050",
		"toolOutput": "#808080",
	}
	var lines []string
	for k, v := range vars {
		lines = append(lines, fmt.Sprintf("      --%s: %s;", k, v))
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

// ── Template helpers ───────────────────────────────────────────────────────

func fmtTime(ts string) string {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ts
	}
	return t.Format("Jan 2, 2006 3:04 PM")
}

func fmtTokens(n int) string {
	if n >= 1_000_000 {
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
	if n >= 1_000 {
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	}
	return fmt.Sprintf("%d", n)
}

func fmtCost(n float64) string {
	if n == 0 {
		return "—"
	}
	return fmt.Sprintf("$%.4f", n)
}

func sessionName(s Session) string {
	if s.Header != nil {
		if name, ok := s.Header["name"].(string); ok && name != "" {
			return name
		}
	}
	for _, e := range s.Entries {
		if e["type"] == "message" {
			msg, ok := e["message"].(map[string]any)
			if ok {
				if role, _ := msg["role"].(string); role == "user" {
					content := msg["content"]
					var text string
					switch v := content.(type) {
					case string:
						text = v
					case []any:
						for _, item := range v {
							if block, ok := item.(map[string]any); ok {
								if t, _ := block["type"].(string); t == "text" {
									text += fmt.Sprintf("%v", block["text"])
								}
							}
						}
					}
					if runes := []rune(text); len(runes) > 80 {
						text = string(runes[:80]) + "…"
					}
					return text
				}
			}
		}
	}
	return s.Filename
}

var funcMap = template.FuncMap{
	"fmtTime":     fmtTime,
	"fmtTokens":   fmtTokens,
	"fmtCost":     fmtCost,
	"sessionName": sessionName,
}

//go:embed templates/index.html
var indexHtml string

var indexTmpl = template.Must(template.New("index").Funcs(funcMap).Parse(indexHtml))
