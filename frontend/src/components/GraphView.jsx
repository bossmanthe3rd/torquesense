import { useState, useRef, useCallback, useEffect } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const NODE_CONFIG = {
  Car:       { color: '#6db5ae', glow: '#4a9d96', label: 'Car Models' },
  Component: { color: '#ca8a04', glow: '#a16207', label: 'Components' },
  Manual:    { color: '#16a34a', glow: '#15803d', label: 'Repair Manuals' },
};

const LINK_CONFIG = {
  HAS_COMPONENT:    { color: '#4a9d96', label: 'Has Component' },
  HAS_REPAIR_MANUAL:{ color: '#16a34a', label: 'Has Manual' },
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}

export function GraphView({ graphData, hasConversationGraph }) {
  const fgRef        = useRef(null);
  const containerRef = useRef(null);

  const [dims, setDims]                 = useState({ width: 800, height: 500 });
  const [selectedNode, setSelectedNode] = useState(null);
  const [hoveredNode, setHoveredNode]   = useState(null);
  const [highlightNodes, setHighlightNodes] = useState(new Set());
  const [highlightLinks, setHighlightLinks] = useState(new Set());
  const [searchQuery, setSearchQuery]   = useState('');

  // Responsive sizing via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDims({ width: Math.max(200, width), height: Math.max(200, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-fit when graph data changes
  useEffect(() => {
    if (!graphData.nodes.length) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit(500, 60), 500);
    return () => clearTimeout(t);
  }, [graphData]);

  // Reset UI state when graph is replaced
  useEffect(() => {
    setSelectedNode(null);
    setHoveredNode(null);
    setHighlightNodes(new Set());
    setHighlightLinks(new Set());
    setSearchQuery('');
  }, [graphData]);

  // Cleanup cursor on unmount
  useEffect(() => () => { document.body.style.cursor = 'default'; }, []);

  const getNeighbors = useCallback((node) => {
    const nodes = new Set([node.id]);
    const links = new Set();
    graphData.links.forEach(link => {
      const s = typeof link.source === 'object' ? link.source.id : link.source;
      const t = typeof link.target === 'object' ? link.target.id : link.target;
      if (s === node.id || t === node.id) {
        nodes.add(s);
        nodes.add(t);
        links.add(link);
      }
    });
    return { nodes, links };
  }, [graphData.links]);

  const handleNodeHover = useCallback((node) => {
    setHoveredNode(node || null);
    if (node) {
      const { nodes, links } = getNeighbors(node);
      setHighlightNodes(nodes);
      setHighlightLinks(links);
    } else {
      setHighlightNodes(new Set());
      setHighlightLinks(new Set());
    }
    document.body.style.cursor = node ? 'pointer' : 'default';
  }, [getNeighbors]);

  const handleNodeClick = useCallback((node) => {
    setSelectedNode(prev => prev?.id === node.id ? null : node);
  }, []);

  // Custom node canvas painter
  const paintNode = useCallback((node, ctx, globalScale) => {
    const cfg          = NODE_CONFIG[node.label] ?? { color: '#6b7280', glow: '#6b7280' };
    const isHighlit    = highlightNodes.size === 0 || highlightNodes.has(node.id);
    const isSelected   = selectedNode?.id === node.id;
    const isHovered    = hoveredNode?.id === node.id;
    const isMatch      = searchQuery.length > 1 &&
      node.name.toLowerCase().includes(searchQuery.toLowerCase());

    const r     = isSelected || isHovered ? 10 : 8;
    const alpha = highlightNodes.size > 0 && !isHighlit ? 0.1 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Glow ring
    if (isSelected || isHovered || isMatch) {
      ctx.shadowBlur  = 20;
      ctx.shadowColor = isMatch ? '#ca8a04' : cfg.glow;
    }

    // Node body
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = cfg.color;
    ctx.fill();

    // Border
    if (isSelected || isMatch) {
      ctx.strokeStyle = isMatch ? '#ca8a04' : '#ffffff';
      ctx.lineWidth   = Math.max(1, 2 / globalScale);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;

    // Label
    const maxLen = 20;
    const label  = node.name.length > maxLen ? node.name.slice(0, maxLen - 1) + '…' : node.name;
    const fs     = Math.max(3, 10 / globalScale);
    ctx.font     = `${isSelected || isHovered ? '600 ' : ''}${fs}px Inter, system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    const tw  = ctx.measureText(label).width;
    const pad = Math.max(1, 2.5 / globalScale);
    const lx  = node.x;
    const ly  = node.y + r + Math.max(1, 3 / globalScale);

    // Label pill background
    roundRect(ctx, lx - tw / 2 - pad, ly - pad * 0.5, tw + pad * 2, fs + pad * 1.5, Math.max(1, 2 / globalScale));
    ctx.fillStyle = 'rgba(17,24,39,0.85)';
    ctx.fill();

    // Label text
    ctx.fillStyle = isHighlit ? '#f3f4f6' : '#6b7280';
    ctx.fillText(label, lx, ly + pad * 0.25);

    ctx.restore();
  }, [highlightNodes, selectedNode, hoveredNode, searchQuery]);

  const getLinkColor = useCallback((link) => {
    const isHighlit = highlightLinks.size === 0 || highlightLinks.has(link);
    const base = LINK_CONFIG[link.label]?.color ?? '#475569';
    return isHighlit ? base : 'rgba(71,85,105,0.1)';
  }, [highlightLinks]);

  const getLinkWidth = useCallback((link) =>
    highlightLinks.has(link) ? 2 : 1,
  [highlightLinks]);

  const getLinkParticles = useCallback((link) =>
    highlightLinks.has(link) ? 3 : 0,
  [highlightLinks]);

  // Derived stats
  const nodeCounts = {};
  graphData.nodes.forEach(n => { nodeCounts[n.label] = (nodeCounts[n.label] || 0) + 1; });

  const searchMatches = searchQuery.length > 1
    ? graphData.nodes.filter(n => n.name.toLowerCase().includes(searchQuery.toLowerCase())).length
    : 0;

  // Neighbors of selected node for detail panel
  const selectedNeighbors = selectedNode ? (() => {
    const result = [];
    graphData.links.forEach(link => {
      const s = typeof link.source === 'object' ? link.source : graphData.nodes.find(n => n.id === link.source);
      const t = typeof link.target === 'object' ? link.target : graphData.nodes.find(n => n.id === link.target);
      if (s?.id === selectedNode.id) result.push({ node: t, rel: link.label });
      if (t?.id === selectedNode.id) result.push({ node: s, rel: link.label });
    });
    return result.filter(x => x.node);
  })() : [];

  return (
    <div className="flex-grow flex flex-col bg-gray-950 rounded-2xl border border-gray-700/40 overflow-hidden shadow-lg">

      {/* ── Navbar: Clean minimal top bar ── */}
      <div className="bg-gradient-to-b from-gray-900 to-gray-900/80 border-b border-gray-700/40 flex-shrink-0 px-3 py-2.5 animate-slideDown">
        <div className="flex items-center justify-between gap-3">
          {/* Left: Stats and context badge */}
          <div className="flex items-center gap-2.5">
            {/* Stats */}
            <div className="flex items-center gap-1.5 text-gray-400 text-xs font-mono px-2.5 py-1.5 bg-gray-800/30 rounded-full border border-gray-700/30 hover:bg-gray-800/50 transition-all duration-200">
              <span className="text-gray-200 font-semibold">{graphData.nodes.length}</span>
              <span className="text-gray-500 text-[10px]">nodes</span>
              <span className="text-gray-700">·</span>
              <span className="text-gray-200 font-semibold">{graphData.links.length}</span>
              <span className="text-gray-500 text-[10px]">edges</span>
            </div>

            {/* Context badge */}
            {hasConversationGraph ? (
              <span className="flex items-center gap-1.5 bg-success-600/15 border border-success-600/40 text-success-300 text-xs font-medium px-3 py-1.5 rounded-full transition-all duration-200 hover:bg-success-600/25">
                <span className="w-1.5 h-1.5 rounded-full bg-success-400 animate-pulse inline-block" />
                RAG Context
              </span>
            ) : (
              <span className="flex items-center gap-1.5 bg-gray-800/40 border border-gray-600/30 text-gray-400 text-xs font-medium px-3 py-1.5 rounded-full transition-all duration-200 hover:bg-gray-800/60">
                <span className="w-1.5 h-1.5 rounded-full bg-gray-600 inline-block" />
                Full Database
              </span>
            )}
          </div>

          {/* Right: Controls (search + zoom) */}
          <div className="flex items-center gap-2">
            {/* Search input */}
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none"
                fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search nodes…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="bg-gray-800/50 border border-gray-600/50 text-gray-300 text-xs placeholder-gray-600
                           rounded-full pl-9 pr-3 py-2 focus:outline-none focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20
                           w-40 transition-all duration-200 hover:border-gray-600 hover:bg-gray-800/70"
              />
              {searchQuery.length > 1 && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary-400 pointer-events-none">
                  {searchMatches}
                </span>
              )}
            </div>

            {/* Zoom to fit button (pill style) */}
            <button
              onClick={() => fgRef.current?.zoomToFit(400, 60)}
              title="Zoom to fit"
              className="btn-secondary-pill flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
              Fit
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden min-h-0 gap-2.5 p-2.5">

        {/* ── Left sidebar: Structured card sections ── */}
        <div className="w-52 flex-shrink-0 bg-gradient-to-b from-gray-850/80 to-gray-900/60 rounded-xl border border-gray-700/40 flex flex-col overflow-y-auto animate-slideDown">
          <div className="p-3 space-y-3">

            {/* Node Types Card */}
            <div className="bg-gray-800/50 rounded-lg p-2.5 border border-gray-700/40 space-y-2 hover:border-gray-700/60 transition-all duration-200">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Node Types
              </p>
              <div className="space-y-1.5">
                {Object.entries(NODE_CONFIG).map(([type, cfg]) => (
                  <div key={type} className="flex items-center justify-between hover:bg-gray-700/30 rounded-md px-2 py-1.5 transition-colors duration-150 cursor-default">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0 shadow-md transition-transform duration-200 hover:scale-110"
                        style={{ backgroundColor: cfg.color, boxShadow: `0 0 10px ${cfg.glow}50` }}
                      />
                      <span className="text-xs text-gray-300 truncate">{cfg.label}</span>
                    </div>
                    <span className="text-xs font-mono text-gray-500 flex-shrink-0 ml-1">
                      {nodeCounts[type] ?? 0}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Relationships Card */}
            <div className="bg-gray-800/50 rounded-lg p-2.5 border border-gray-700/40 space-y-2 hover:border-gray-700/60 transition-all duration-200">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Relationships
              </p>
              <div className="space-y-1.5">
                {Object.entries(LINK_CONFIG).map(([type, cfg]) => (
                  <div key={type} className="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-700/30 rounded-md transition-colors duration-150 cursor-default">
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <div className="w-4 h-px" style={{ backgroundColor: cfg.color }} />
                      <svg className="w-2.5 h-2.5" style={{ color: cfg.color }} viewBox="0 0 8 8" fill="currentColor">
                        <polygon points="0,1.5 0,6.5 7,4" />
                      </svg>
                    </div>
                    <span className="text-xs text-gray-400">{cfg.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Controls Card */}
            <div className="bg-gray-800/50 rounded-lg p-2.5 border border-gray-700/40 space-y-2 hover:border-gray-700/60 transition-all duration-200">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Keyboard
              </p>
              <div className="space-y-1">
                {[
                  ['Click', 'Select node'],
                  ['Hover', 'Show neighbors'],
                  ['Scroll', 'Zoom'],
                  ['Drag', 'Pan'],
                ].map(([key, desc]) => (
                  <div key={key} className="flex items-center gap-1.5 px-2 py-0.5">
                    <span className="text-[10px] font-mono bg-primary-600/20 text-primary-300 px-1.5 py-0.5 rounded border border-primary-600/40 flex-shrink-0 leading-tight transition-all duration-200 hover:bg-primary-600/30">
                      {key}
                    </span>
                    <span className="text-xs text-gray-500">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Selected node detail — pinned to bottom */}
          {selectedNode && (
            <div className="mt-auto border-t border-gray-700/40 p-3 animate-slideInUp">
              <div className="bg-gray-800/60 rounded-lg p-2.5 border border-gray-700/40 space-y-2.5 hover:border-gray-700/60 transition-all duration-200">
                <div className="flex items-center gap-2 pb-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: NODE_CONFIG[selectedNode.label]?.color ?? '#6b7280' }}
                  />
                  <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                    {selectedNode.label}
                  </p>
                </div>

                <div>
                  <p className="text-sm font-semibold text-white break-words leading-snug line-clamp-3">
                    {selectedNode.name}
                  </p>
                </div>

                {selectedNeighbors.length > 0 && (
                  <div className="border-t border-gray-700/40 pt-2 space-y-1.5">
                    <p className="text-[10px] font-semibold text-gray-600 uppercase tracking-wider">
                      Connected ({selectedNeighbors.length})
                    </p>
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {selectedNeighbors.slice(0, 8).map((nb, i) => (
                        <div key={i} className="flex items-center gap-1.5 px-1.5 py-0.5 hover:bg-gray-700/30 rounded transition-colors duration-150 cursor-default">
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: NODE_CONFIG[nb.node?.label]?.color ?? '#6b7280' }}
                          />
                          <span className="text-[11px] text-gray-400 truncate" title={nb.node?.name}>
                            {nb.node?.name}
                          </span>
                        </div>
                      ))}
                      {selectedNeighbors.length > 8 && (
                        <p className="text-[10px] text-gray-600 px-1.5 py-0.5">
                          +{selectedNeighbors.length - 8} more
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <button
                  onClick={() => setSelectedNode(null)}
                  className="btn-ghost w-full text-[11px]"
                >
                  Clear Selection
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── Graph canvas: Clean container with subtle backgrounds ── */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden rounded-xl border border-gray-700/40 bg-gradient-to-br from-gray-850 via-gray-900 to-gray-950 shadow-inner animate-slideDown" style={{animationDelay: '50ms'}}>
          {/* Vignette overlay for subtle depth */}
          <div className="absolute inset-0 pointer-events-none bg-gradient-to-br from-transparent via-transparent to-gray-950/20"></div>
          
          <ForceGraph2D
            ref={fgRef}
            graphData={graphData}
            width={dims.width}
            height={dims.height}
            backgroundColor="#111827"
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => 'replace'}
            nodeLabel=""
            nodeRelSize={8}
            linkColor={getLinkColor}
            linkWidth={getLinkWidth}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={getLinkColor}
            linkDirectionalParticles={getLinkParticles}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleSpeed={0.005}
            linkDirectionalParticleColor={getLinkColor}
            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            cooldownTicks={150}
            onEngineStop={() => fgRef.current?.zoomToFit(500, 60)}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.35}
          />

          {/* Hover tooltip — elegant card style */}
          {hoveredNode && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pointer-events-none z-20 animate-slideUp">
              <div className="flex items-center gap-2 bg-gray-900/95 backdrop-blur-sm border border-gray-600/40
                              rounded-lg px-3 py-2 shadow-lg text-xs whitespace-nowrap transition-all duration-200 hover:shadow-xl">
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: NODE_CONFIG[hoveredNode.label]?.color ?? '#6b7280' }}
                />
                <span className="text-gray-400 font-medium">{hoveredNode.label}</span>
                <span className="w-px h-3 bg-gray-700" />
                <span className="text-white font-semibold">{hoveredNode.name}</span>
              </div>
            </div>
          )}

          {/* Empty state */}
          {graphData.nodes.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none animate-fadeIn">
              <div className="w-14 h-14 rounded-xl bg-gray-800/50 border border-gray-700/30 flex items-center justify-center mb-3">
                <svg className="w-7 h-7 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
                </svg>
              </div>
              <p className="text-gray-400 text-sm font-semibold mb-0.5">No graph data</p>
              <p className="text-gray-600 text-xs text-center max-w-xs">
                Run a diagnostic to see the knowledge graph.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
