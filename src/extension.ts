import * as vscode from 'vscode';

// ----------------------------------------------------------------------------
// TYPES
// ----------------------------------------------------------------------------

interface FileNode {
  id: string;
  name: string;
  relativePath: string;
  loc: number;
  complexity: number;   // raw count of branching/function keywords
  density: number;      // complexity per 100 lines, used for pulse intensity
  mass: number;          // derived "mass" used by the gravity sim
}

// ----------------------------------------------------------------------------
// ACTIVATION
// ----------------------------------------------------------------------------

const CODE_GLOB = '**/*.{ts,tsx,js,jsx,py,java,cs,go,rb,rs,cpp,c,h,hpp,php,swift,kt}';
const EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,out,build,.next,.venv,venv,__pycache__,target,bin,obj}/**';

// Keywords used as a cheap proxy for "complexity". Not a real cyclomatic
// complexity calculation, but a reasonable density signal for visualization.
const COMPLEXITY_KEYWORDS = [
  'if', 'else', 'switch', 'case', 'for', 'while', 'catch', 'function', 'def', 'async'
];

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('codeGravity.start', async () => {
    const panel = vscode.window.createWebviewPanel(
      'codeGravity',
      'Code Gravity',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    panel.webview.html = getWebviewContent();

    // Kick off the scan as soon as the panel is ready. We don't wait for a
    // "ready" handshake from the webview here for simplicity, but the
    // webview also re-requests data on load via postMessage({type: 'ready'})
    // in case the extension message arrives before its listener is attached.
    const nodes = await scanWorkspace();
    panel.webview.postMessage({ type: 'fileData', nodes });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        const freshNodes = await scanWorkspace();
        panel.webview.postMessage({ type: 'fileData', nodes: freshNodes });
      }
      if (message?.type === 'rescan') {
        const freshNodes = await scanWorkspace();
        panel.webview.postMessage({ type: 'fileData', nodes: freshNodes });
      }
      if (message?.type === 'openFile') {
        try {
          const uri = vscode.Uri.parse(message.uri);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        } catch (err) {
          vscode.window.showErrorMessage(`Code Gravity: unable to open file - ${err}`);
        }
      }
    });
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {}

// ----------------------------------------------------------------------------
// WORKSPACE SCANNER
// ----------------------------------------------------------------------------

async function scanWorkspace(): Promise<FileNode[]> {
  const uris = await vscode.workspace.findFiles(CODE_GLOB, EXCLUDE_GLOB, 5000);

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const rootPath = workspaceFolders && workspaceFolders.length > 0
    ? workspaceFolders[0].uri.fsPath
    : '';

  const nodes: FileNode[] = [];

  for (const uri of uris) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');

      // Skip empty or absurdly large files (probably minified/generated).
      if (text.length === 0 || text.length > 2_000_000) {
        continue;
      }

      const loc = countLinesOfCode(text);
      if (loc === 0) {
        continue;
      }

      const complexity = countComplexityKeywords(text);
      const density = (complexity / loc) * 100;

      const relativePath = rootPath
        ? uri.fsPath.substring(rootPath.length).replace(/^[\\/]/, '')
        : uri.fsPath;

      nodes.push({
        id: uri.toString(),
        name: relativePath.split(/[\\/]/).pop() || relativePath,
        relativePath,
        loc,
        complexity,
        density,
        // Mass scales with lines of code. sqrt keeps huge files from
        // completely dwarfing everything else on screen while still
        // clearly separating the "monolith" from small files.
        mass: Math.sqrt(loc),
      });
    } catch {
      // Unreadable file (binary, permission issue, etc.) - skip silently.
      continue;
    }
  }

  return nodes;
}

function countLinesOfCode(text: string): number {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim().length > 0).length;
}

function countComplexityKeywords(text: string): number {
  let total = 0;
  for (const keyword of COMPLEXITY_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'g');
    const matches = text.match(regex);
    if (matches) {
      total += matches.length;
    }
  }
  return total;
}

// ----------------------------------------------------------------------------
// WEBVIEW CONTENT
// ----------------------------------------------------------------------------

function getWebviewContent(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<title>Code Gravity</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    background: #05060a;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #space {
    display: block;
    width: 100vw;
    height: 100vh;
  }
  #tooltip {
    position: fixed;
    pointer-events: none;
    display: none;
    background: rgba(10, 12, 20, 0.92);
    border: 1px solid rgba(120, 180, 255, 0.35);
    border-radius: 6px;
    padding: 8px 12px;
    color: #d7e6ff;
    font-size: 12px;
    line-height: 1.5;
    box-shadow: 0 0 16px rgba(80, 140, 255, 0.25);
    max-width: 320px;
    z-index: 10;
  }
  #tooltip .file {
    font-weight: 600;
    color: #ffffff;
    word-break: break-all;
  }
  #tooltip .stat {
    color: #8fb8ff;
  }
  #hud {
    position: fixed;
    top: 10px;
    left: 14px;
    color: #6b7a99;
    font-size: 11px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    z-index: 10;
    user-select: none;
  }
  #hud span {
    color: #dbe8ff;
  }
  #empty {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #566180;
    font-size: 13px;
    display: none;
    text-align: center;
  }
</style>
</head>
<body>
<canvas id="space"></canvas>
<div id="tooltip"></div>
<div id="hud">Code Gravity &middot; <span id="fileCount">0</span> files mapped</div>
<div id="empty">Scanning workspace for code files&hellip;</div>

<script>
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('space');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const hudCount = document.getElementById('fileCount');
  const emptyEl = document.getElementById('empty');

  let width, height;
  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------------
  // Starfield background (purely decorative, static parallax dots)
  // ---------------------------------------------------------------
  const STAR_COUNT = 260;
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.3 + 0.2,
      twinkleSpeed: Math.random() * 0.02 + 0.005,
      twinklePhase: Math.random() * Math.PI * 2,
    });
  }

  // ---------------------------------------------------------------
  // Physics bodies
  // ---------------------------------------------------------------
  const G = 0.06;             // gravitational constant, tuned for screen-space
  const DAMPING = 0.9995;     // slight velocity decay so orbits settle
  const MIN_DIST = 26;        // softens force at close range to avoid slingshots
  const MAX_PARTICLES = 400;  // safety cap for huge workspaces

  let bodies = [];
  let monolith = null;
  let hovered = null;
  let animationFrame = null;

  function colorForNode(node, isMonolith) {
    if (isMonolith) {
      return { core: '#ff5a3c', glow: 'rgba(255, 90, 60, 0.55)' };
    }
    // Blend blue -> green -> amber as density (complexity) rises.
    const t = Math.min(node.density / 15, 1);
    if (t < 0.5) {
      const k = t / 0.5;
      return {
        core: lerpColor('#4fc3ff', '#63e6a3', k),
        glow: 'rgba(79, 195, 255, 0.35)',
      };
    } else {
      const k = (t - 0.5) / 0.5;
      return {
        core: lerpColor('#63e6a3', '#ffd166', k),
        glow: 'rgba(255, 209, 102, 0.35)',
      };
    }
  }

  function lerpColor(a, b, t) {
    const ca = hexToRgb(a), cb = hexToRgb(b);
    const r = Math.round(ca.r + (cb.r - ca.r) * t);
    const g = Math.round(ca.g + (cb.g - ca.g) * t);
    const bl = Math.round(ca.b + (cb.b - ca.b) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }
  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }

  function buildBodies(nodes) {
    if (!nodes || nodes.length === 0) {
      emptyEl.textContent = 'No code files found in this workspace.';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    const sorted = [...nodes].sort((a, b) => b.loc - a.loc);
    const capped = sorted.slice(0, MAX_PARTICLES);
    const monolithNode = capped[0];
    const satellites = capped.slice(1);

    const cx = width / 2;
    const cy = height / 2;

    monolith = {
      node: monolithNode,
      x: cx,
      y: cy,
      vx: 0,
      vy: 0,
      radius: clamp(18 + Math.sqrt(monolithNode.loc) * 0.9, 22, 70),
      mass: monolithNode.mass * 40, // monolith mass weighted heavily
      isMonolith: true,
      pulsePhase: 0,
      colors: colorForNode(monolithNode, true),
    };

    bodies = [monolith];

    satellites.forEach((node, i) => {
      const angle = (i / satellites.length) * Math.PI * 2 + Math.random() * 0.5;
      const distance = 140 + Math.random() * Math.min(width, height) * 0.42;
      const x = cx + Math.cos(angle) * distance;
      const y = cy + Math.sin(angle) * distance;

      // Rough circular-orbit velocity: v = sqrt(G * M / r)
      const orbitalSpeed = Math.sqrt((G * monolith.mass) / distance) * (0.85 + Math.random() * 0.3);
      const vx = -Math.sin(angle) * orbitalSpeed;
      const vy = Math.cos(angle) * orbitalSpeed;

      bodies.push({
        node,
        x, y, vx, vy,
        radius: clamp(2 + node.mass * 0.35, 2.5, 14),
        mass: Math.max(node.mass, 1),
        isMonolith: false,
        pulsePhase: Math.random() * Math.PI * 2,
        colors: colorForNode(node, false),
      });
    });

    hudCount.textContent = String(nodes.length);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---------------------------------------------------------------
  // Physics step: F = (G * m1 * m2) / r^2, attraction toward monolith
  // and toward each other for lightweight mutual gravity.
  // ---------------------------------------------------------------
  function step() {
    const cx = width / 2;
    const cy = height / 2;

    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.isMonolith) continue;

      let fx = 0, fy = 0;

      for (let j = 0; j < bodies.length; j++) {
        if (i === j) continue;
        const other = bodies[j];
        const dx = other.x - b.x;
        const dy = other.y - b.y;
        let distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq) || 0.001;

        if (dist < MIN_DIST) distSq = MIN_DIST * MIN_DIST;

        const force = (G * b.mass * other.mass) / distSq;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }

      b.vx = (b.vx + fx / b.mass) * DAMPING;
      b.vy = (b.vy + fy / b.mass) * DAMPING;
      b.x += b.vx;
      b.y += b.vy;

      // Gentle recentering pull so escaped particles drift back toward
      // the visible canvas instead of flying off into the void forever.
      const distFromCenter = Math.hypot(b.x - cx, b.y - cy);
      const maxRadius = Math.max(width, height) * 0.55;
      if (distFromCenter > maxRadius) {
        b.vx += (cx - b.x) * 0.00004;
        b.vy += (cy - b.y) * 0.00004;
      }
    }

    // Monolith drifts almost imperceptibly for a subtle "alive" feel.
	if(monolith){
		monolith.pulsePhase += 0.02;
	}
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  function draw() {
    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, width, height);

    // Starfield
    const t = Date.now() * 0.001;
    for (const s of stars) {
      const twinkle = 0.55 + 0.45 * Math.sin(t * (s.twinkleSpeed * 60) + s.twinklePhase);
      ctx.beginPath();
      ctx.arc(s.x * width, s.y * height, s.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.25 + twinkle * 0.5).toFixed(3) + ')';
      ctx.fill();
    }

    if (bodies.length === 0) return;

    // Orbit trails toward monolith (subtle)
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = '#4fc3ff';
    for (const b of bodies) {
      if (b.isMonolith) continue;
      ctx.beginPath();
      ctx.moveTo(monolith.x, monolith.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();

    // Bodies
    for (const b of bodies) {
      drawBody(b);
    }
  }

  function drawBody(b) {
    const isHovered = b === hovered;

    if (b.isMonolith) {
      const pulse = 1 + Math.sin(b.pulsePhase) * 0.08 * clamp(b.node.density / 6, 0.3, 1.6);
      const r = b.radius * pulse;

      const glow = ctx.createRadialGradient(b.x, b.y, r * 0.2, b.x, b.y, r * 3.2);
      glow.addColorStop(0, b.colors.glow);
      glow.addColorStop(1, 'rgba(255, 90, 60, 0)');
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 3.2, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      const core = ctx.createRadialGradient(b.x - r * 0.3, b.y - r * 0.3, r * 0.1, b.x, b.y, r);
      core.addColorStop(0, '#fff2ea');
      core.addColorStop(0.4, b.colors.core);
      core.addColorStop(1, '#7a1c0e');
      ctx.fillStyle = core;
      ctx.fill();

      if (isHovered) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 220, 200, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      return;
    }

    const r = b.radius * (isHovered ? 1.25 : 1);

    const glow = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 2.6);
    glow.addColorStop(0, b.colors.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(b.x, b.y, r * 2.6, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fillStyle = b.colors.core;
    ctx.fill();

    if (isHovered) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  function loop() {
    step();
    draw();
    animationFrame = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------
  // Hover / tooltip interaction
  // ---------------------------------------------------------------
  canvas.addEventListener('mousemove', (e) => {
    const mx = e.clientX;
    const my = e.clientY;
    let found = null;

    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      const dist = Math.hypot(b.x - mx, b.y - my);
      if (dist <= b.radius + 4) {
        found = b;
        break;
      }
    }

    hovered = found;

    if (found) {
      tooltip.style.display = 'block';
      tooltip.style.left = (mx + 16) + 'px';
      tooltip.style.top = (my + 16) + 'px';
      tooltip.innerHTML =
        '<div class="file">' + escapeHtml(found.node.relativePath) + '</div>' +
        '<div class="stat">Lines of code: ' + found.node.loc + '</div>' +
        '<div class="stat">Complexity score: ' + found.node.complexity + '</div>' +
        (found.isMonolith ? '<div class="stat" style="color:#ff9c7a;">⚠ Monolith — largest file in workspace</div>' : '');
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'default';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    hovered = null;
    tooltip.style.display = 'none';
  });

  canvas.addEventListener('click', () => {
    if (hovered) {
      vscode.postMessage({ type: 'openFile', uri: hovered.node.id });
    }
  });

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ---------------------------------------------------------------
  // Message handling from extension.ts
  // ---------------------------------------------------------------
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'fileData') {
      buildBodies(message.nodes);
    }
  });

  // Ask the extension for data in case it posted before we were listening.
  vscode.postMessage({ type: 'ready' });

  loop();
})();
</script>
</body>
</html>`;
}