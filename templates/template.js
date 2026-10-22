    (function() {
      'use strict';

      // ============================================================
      // DATA LOADING
      // ============================================================

      const base64 = document.getElementById('session-data').textContent;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      let { header, leafId: defaultLeafId, systemPrompt, tools, renderedTools } = data;
      let originalEntries = Array.isArray(data.entries) ? data.entries : [];
      let entries = normalizeEntries(originalEntries);

      function normalizeEntries(source) {
        const unique = new Map();
        for (const raw of source) {
          if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || raw.type === 'session' || raw.type === 'header') continue;
          const entry = { ...raw };
          if (entry.type === 'message') {
            if (!entry.message || typeof entry.message !== 'object' || typeof entry.message.role !== 'string') continue;
            const msg = { ...entry.message };
            const content = msg.content;
            msg.content = Array.isArray(content) ? content.filter(block => block && typeof block === 'object').map(block => {
              if (block.type === 'text') return { ...block, text: String(block.text ?? '') };
              if (block.type === 'thinking') return { ...block, thinking: String(block.thinking ?? '') };
              return block;
            })
              : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
            entry.message = msg;
          }
          unique.set(entry.id, entry);
        }
        // Break malformed parent cycles in linear time, without changing the
        // original JSONL used for download. Every entry remains reachable.
        const resolved = new Set();
        for (const entry of unique.values()) {
          const path = new Set();
          let current = entry;
          while (current && !resolved.has(current.id)) {
            path.add(current.id);
            if (path.has(current.parentId)) {
              current.parentId = null;
              break;
            }
            current = unique.get(current.parentId);
          }
          path.forEach(id => resolved.add(id));
        }
        return Array.from(unique.values());
      }

      // ============================================================
      // URL PARAMETER HANDLING
      // ============================================================

      // Parse URL parameters for deep linking: leafId and targetId
      // Check for injected params (when loaded in iframe via srcdoc) or use window.location
      const injectedParams = document.querySelector('meta[name="pi-url-params"]');
      const searchString = injectedParams ? injectedParams.content : window.location.search.substring(1);
      const urlParams = new URLSearchParams(searchString);
      const urlLeafId = urlParams.get('leafId');
      const urlTargetId = urlParams.get('targetId');
      // Stale deep links should still open the available conversation.
      const leafId = [urlLeafId, defaultLeafId].find(id => id && entries.some(entry => entry.id === id))
        || entries[entries.length - 1]?.id || null;

      // ============================================================
      // DATA STRUCTURES
      // ============================================================

      // Entry lookup by ID
      const byId = new Map();
      for (const entry of entries) {
        byId.set(entry.id, entry);
      }

      function rebuildLookups() {
        byId.clear();
        toolCallMap.clear();
        labelMap.clear();
        for (const entry of entries) {
          byId.set(entry.id, entry);
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            for (const block of entry.message.content) {
              if (block.type === 'toolCall') toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
            }
          }
          if (entry.type === 'label' && entry.targetId && entry.label) labelMap.set(entry.targetId, entry.label);
        }
      }

      // Tool call lookup (toolCallId -> {name, arguments})
      const toolCallMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'message' && entry.message.role === 'assistant') {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'toolCall') {
                toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
              }
            }
          }
        }
      }

      // Label lookup (entryId -> label string)
      // Labels are stored in 'label' entries that reference their target via targetId
      const labelMap = new Map();
      for (const entry of entries) {
        if (entry.type === 'label' && entry.targetId && entry.label) {
          labelMap.set(entry.targetId, entry.label);
        }
      }

      // ============================================================
      // TREE DATA PREPARATION (no DOM, pure data)
      // ============================================================

      /**
       * Build tree structure from flat entries.
       * Returns array of root nodes, each with { entry, children, label }.
       */
      function buildTree() {
        const nodeMap = new Map();
        const roots = [];

        // Create nodes
        for (const entry of entries) {
          nodeMap.set(entry.id, {
            entry,
            children: [],
            label: labelMap.get(entry.id)
          });
        }

        // Build parent-child relationships
        for (const entry of entries) {
          const node = nodeMap.get(entry.id);
          if (entry.parentId === null || entry.parentId === undefined || entry.parentId === entry.id) {
            roots.push(node);
          } else {
            const parent = nodeMap.get(entry.parentId);
            if (parent) {
              parent.children.push(node);
            } else {
              roots.push(node);
            }
          }
        }

        // Sort children by timestamp
        for (const node of nodeMap.values()) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
        }

        return roots;
      }

      /**
       * Build set of entry IDs on path from root to target.
       */
      function buildActivePathIds(targetId) {
        const ids = new Set();
        let current = byId.get(targetId);
        while (current && !ids.has(current.id)) {
          ids.add(current.id);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return ids;
      }

      /**
       * Get array of entries from root to target (the conversation path).
       */
      function getPath(targetId) {
        const path = [];
        const visited = new Set();
        let current = byId.get(targetId);
        while (current && !visited.has(current.id)) {
          visited.add(current.id);
          path.push(current);
          // Stop if no parent or self-referencing (root)
          if (!current.parentId || current.parentId === current.id) {
            break;
          }
          current = byId.get(current.parentId);
        }
        return path.reverse();
      }

      // Tree node lookup for finding leaves
      let treeNodeMap = null;

      /**
       * Find the newest leaf node reachable from a given node.
       * This allows clicking any node in a branch to show the full branch.
       * Children are sorted by timestamp, so the newest is always last.
       */
      function findNewestLeaf(nodeId) {
        // Build tree node map lazily
        if (!treeNodeMap) {
          treeNodeMap = new Map();
          const tree = buildTree();
          const stack = [...tree];
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (const child of node.children) stack.push(child);
          }
        }

        const node = treeNodeMap.get(nodeId);
        if (!node) return nodeId;

        // Follow the newest (last) child at each level
        let current = node;
        while (current.children.length > 0) {
          current = current.children[current.children.length - 1];
        }
        return current.entry.id;
      }

      /**
       * Flatten tree into list with indentation and connector info.
       * Returns array of { node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots }.
       * Matches tree-selector.ts logic exactly.
       */
      function flattenTree(roots, activePathIds) {
        const result = [];
        const multipleRoots = roots.length > 1;

        // Mark which subtrees contain the active leaf
        const containsActive = new Map();
        const pending = [...roots];
        while (pending.length) {
          const node = pending.pop();
          // Active-path IDs already include every ancestor of the leaf.
          containsActive.set(node, activePathIds.has(node.entry.id));
          for (const child of node.children) pending.push(child);
        }

        // Stack: [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add roots (prioritize branch containing active leaf)
        const orderedRoots = [...roots].sort((a, b) =>
          Number(containsActive.get(b)) - Number(containsActive.get(a))
        );
        for (let i = orderedRoots.length - 1; i >= 0; i--) {
          const isLast = i === orderedRoots.length - 1;
          stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
        }

        while (stack.length > 0) {
          const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots });

          const children = node.children;
          const multipleChildren = children.length > 1;

          // Order children (active branch first)
          const orderedChildren = [...children].sort((a, b) =>
            Number(containsActive.get(b)) - Number(containsActive.get(a))
          );

          // Calculate child indent (matches tree-selector.ts)
          let childIndent;
          if (multipleChildren) {
            // Parent branches: children get +1
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            // First generation after a branch: +1 for visual grouping
            childIndent = indent + 1;
          } else {
            // Single-child chain: stay flat
            childIndent = indent;
          }

          // Build gutters for children
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order for stack
          for (let i = orderedChildren.length - 1; i >= 0; i--) {
            const childIsLast = i === orderedChildren.length - 1;
            stack.push([orderedChildren[i], childIndent, multipleChildren, multipleChildren, childIsLast, childGutters, false]);
          }
        }

        return result;
      }

      /**
       * Build ASCII prefix string for tree node.
       */
      function buildTreePrefix(flatNode) {
        const { indent, showConnector, isLast, gutters, isVirtualRootChild, multipleRoots } = flatNode;
        const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
        const connector = showConnector && !isVirtualRootChild ? (isLast ? '└─ ' : '├─ ') : '';
        const connectorPosition = connector ? displayIndent - 1 : -1;

        const totalChars = displayIndent * 3;
        const prefixChars = [];
        for (let i = 0; i < totalChars; i++) {
          const level = Math.floor(i / 3);
          const posInLevel = i % 3;

          const gutter = gutters.find(g => g.position === level);
          if (gutter) {
            prefixChars.push(posInLevel === 0 ? (gutter.show ? '│' : ' ') : ' ');
          } else if (connector && level === connectorPosition) {
            if (posInLevel === 0) {
              prefixChars.push(isLast ? '└' : '├');
            } else if (posInLevel === 1) {
              prefixChars.push('─');
            } else {
              prefixChars.push(' ');
            }
          } else {
            prefixChars.push(' ');
          }
        }
        return prefixChars.join('');
      }

      // ============================================================
      // FILTERING (pure data)
      // ============================================================

      let filterMode = 'default';
      let searchQuery = '';

      function hasTextContent(content) {
        if (typeof content === 'string') return content.trim().length > 0;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text && c.text.trim().length > 0) return true;
          }
        }
        return false;
      }

      function extractContent(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('');
        }
        return '';
      }

      function getSearchableText(entry, label) {
        const parts = [];
        if (label) parts.push(label);

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            parts.push(msg.role);
            if (msg.content) parts.push(extractContent(msg.content));
            if (msg.role === 'bashExecution' && msg.command) parts.push(msg.command);
            break;
          }
          case 'custom_message':
            parts.push(entry.customType);
            parts.push(typeof entry.content === 'string' ? entry.content : extractContent(entry.content));
            break;
          case 'compaction':
            parts.push('compaction');
            break;
          case 'branch_summary':
            parts.push('branch summary', entry.summary);
            break;
          case 'model_change':
            parts.push('model', entry.modelId);
            break;
          case 'thinking_level_change':
            parts.push('thinking', entry.thinkingLevel);
            break;
        }

        return parts.join(' ').toLowerCase();
      }

      /**
       * Filter flat nodes based on current filterMode and searchQuery.
       */
      function filterNodes(flatNodes, currentLeafId) {
        const searchTokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

        const filtered = flatNodes.filter(flatNode => {
          const entry = flatNode.node.entry;
          const label = flatNode.node.label;
          const isCurrentLeaf = entry.id === currentLeafId;

          // Keep the current leaf in the unsearched tree, but do not let it
          // appear as a false-positive search result.
          if (isCurrentLeaf && searchTokens.length === 0) return true;

          // Hide assistant messages with only tool calls (no text) unless error/aborted
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            const msg = entry.message;
            const hasText = hasTextContent(msg.content);
            const isErrorOrAborted = msg.stopReason && msg.stopReason !== 'stop' && msg.stopReason !== 'toolUse';
            if (!hasText && !isErrorOrAborted) return false;
          }

          // Apply filter mode
          const isSettingsEntry = ['label', 'custom', 'model_change', 'thinking_level_change'].includes(entry.type);
          let passesFilter = true;

          switch (filterMode) {
            case 'user-only':
              passesFilter = entry.type === 'message' && entry.message.role === 'user';
              break;
            case 'no-tools':
              passesFilter = !isSettingsEntry && !(entry.type === 'message' && entry.message.role === 'toolResult');
              break;
            case 'labeled-only':
              passesFilter = label !== undefined;
              break;
            case 'all':
              passesFilter = true;
              break;
            default: // 'default'
              passesFilter = !isSettingsEntry;
              break;
          }

          if (!passesFilter) return false;

          // Apply search filter
          if (searchTokens.length > 0) {
            const nodeText = getSearchableText(entry, label);
            if (!searchTokens.every(t => nodeText.includes(t))) return false;
          }

          return true;
        });

        // Recalculate visual structure based on visible tree
        recalculateVisualStructure(filtered, flatNodes);

        return filtered;
      }

      /**
       * Recompute indentation/connectors for the filtered view
       *
       * Filtering can hide intermediate entries; descendants attach to the nearest visible ancestor.
       * Keep indentation semantics aligned with flattenTree() so single-child chains don't drift right.
       */
      function recalculateVisualStructure(filteredNodes, allFlatNodes) {
        if (filteredNodes.length === 0) return;

        const visibleIds = new Set(filteredNodes.map(n => n.node.entry.id));

        // Build entry map for parent lookup (using full tree)
        const entryMap = new Map();
        for (const flatNode of allFlatNodes) {
          entryMap.set(flatNode.node.entry.id, flatNode);
        }

        // Find nearest visible ancestor for a node
        function findVisibleAncestor(nodeId) {
          let currentId = entryMap.get(nodeId)?.node.entry.parentId;
          while (currentId != null) {
            if (visibleIds.has(currentId)) {
              return currentId;
            }
            currentId = entryMap.get(currentId)?.node.entry.parentId;
          }
          return null;
        }

        // Build visible tree structure
        const visibleParent = new Map();
        const visibleChildren = new Map();
        visibleChildren.set(null, []); // root-level nodes

        for (const flatNode of filteredNodes) {
          const nodeId = flatNode.node.entry.id;
          const ancestorId = findVisibleAncestor(nodeId);
          visibleParent.set(nodeId, ancestorId);

          if (!visibleChildren.has(ancestorId)) {
            visibleChildren.set(ancestorId, []);
          }
          visibleChildren.get(ancestorId).push(nodeId);
        }

        // Update multipleRoots based on visible roots
        const visibleRootIds = visibleChildren.get(null);
        const multipleRoots = visibleRootIds.length > 1;

        // Build a map for quick lookup: nodeId → FlatNode
        const filteredNodeMap = new Map();
        for (const flatNode of filteredNodes) {
          filteredNodeMap.set(flatNode.node.entry.id, flatNode);
        }

        // DFS traversal of visible tree, applying same indentation rules as flattenTree()
        // Stack items: [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild]
        const stack = [];

        // Add visible roots in reverse order (to process in forward order via stack)
        for (let i = visibleRootIds.length - 1; i >= 0; i--) {
          const isLast = i === visibleRootIds.length - 1;
          stack.push([
            visibleRootIds[i],
            multipleRoots ? 1 : 0,
            multipleRoots,
            multipleRoots,
            isLast,
            [],
            multipleRoots
          ]);
        }

        while (stack.length > 0) {
          const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop();

          const flatNode = filteredNodeMap.get(nodeId);
          if (!flatNode) continue;

          // Update this node's visual properties
          flatNode.indent = indent;
          flatNode.showConnector = showConnector;
          flatNode.isLast = isLast;
          flatNode.gutters = gutters;
          flatNode.isVirtualRootChild = isVirtualRootChild;
          flatNode.multipleRoots = multipleRoots;

          // Get visible children of this node
          const children = visibleChildren.get(nodeId) || [];
          const multipleChildren = children.length > 1;

          // Calculate child indent using same rules as flattenTree():
          // - Parent branches (multiple children): children get +1
          // - Just branched and indent > 0: children get +1 for visual grouping
          // - Single-child chain: stay flat
          let childIndent;
          if (multipleChildren) {
            childIndent = indent + 1;
          } else if (justBranched && indent > 0) {
            childIndent = indent + 1;
          } else {
            childIndent = indent;
          }

          // Build gutters for children (same logic as flattenTree)
          const connectorDisplayed = showConnector && !isVirtualRootChild;
          const currentDisplayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
          const connectorPosition = Math.max(0, currentDisplayIndent - 1);
          const childGutters = connectorDisplayed
            ? [...gutters, { position: connectorPosition, show: !isLast }]
            : gutters;

          // Add children in reverse order (to process in forward order via stack)
          for (let i = children.length - 1; i >= 0; i--) {
            const childIsLast = i === children.length - 1;
            stack.push([
              children[i],
              childIndent,
              multipleChildren,
              multipleChildren,
              childIsLast,
              childGutters,
              false
            ]);
          }
        }
      }

      // ============================================================
      // TREE DISPLAY TEXT (pure data -> string)
      // ============================================================

      function shortenPath(p) {
        if (typeof p !== 'string') return '';
        if (p.startsWith('/Users/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/Users/' + parts[2]).length);
        }
        if (p.startsWith('/home/')) {
          const parts = p.split('/');
          if (parts.length > 2) return '~' + p.slice(('/home/' + parts[2]).length);
        }
        return p;
      }

      function formatToolCall(name, args) {
        switch (name) {
          case 'read': {
            const path = shortenPath(String(args.path || args.file_path || ''));
            const offset = args.offset;
            const limit = args.limit;
            let display = path;
            if (offset !== undefined || limit !== undefined) {
              const start = offset ?? 1;
              const end = limit !== undefined ? start + limit - 1 : '';
              display += `:${start}${end ? `-${end}` : ''}`;
            }
            return `[read: ${display}]`;
          }
          case 'write':
            return `[write: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'edit':
            return `[edit: ${shortenPath(String(args.path || args.file_path || ''))}]`;
          case 'bash': {
            const rawCmd = String(args.command || '');
            const cmd = rawCmd.replace(/[\n\t]/g, ' ').trim().slice(0, 50);
            return `[bash: ${cmd}${rawCmd.length > 50 ? '...' : ''}]`;
          }
          case 'grep':
            return `[grep: /${args.pattern || ''}/ in ${shortenPath(String(args.path || '.'))}]`;
          case 'find':
            return `[find: ${args.pattern || ''} in ${shortenPath(String(args.path || '.'))}]`;
          case 'ls':
            return `[ls: ${shortenPath(String(args.path || '.'))}]`;
          default: {
            const argsStr = JSON.stringify(args).slice(0, 40);
            return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? '...' : ''}]`;
          }
        }
      }

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text == null ? '' : String(text);
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      }

      // Only bundled raster attachments may load automatically. Exported sessions
      // must not contact remote image hosts or execute SVG/HTML attachments.
      function renderAttachmentImage(img, className) {
        const mime = String(img.mimeType || 'image/png').toLowerCase();
        const base64Data = typeof img.data === 'string' ? img.data.replace(/\s/g, '') : '';
        if (!/^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(mime) || !/^[a-zA-Z0-9+/]+={0,2}$/.test(base64Data)) {
          return '<span class="image-blocked">Unsupported image attachment</span>';
        }
        return `<img src="data:${mime};base64,${base64Data}" class="${className}" alt="Session image attachment" loading="lazy" tabindex="0" role="button" aria-label="Open image attachment" />`;
      }

      /**
       * Truncate string to maxLen chars, append "..." if truncated.
       */
      function truncate(s, maxLen = 100) {
        s = String(s ?? '');
        if (s.length <= maxLen) return s;
        return s.slice(0, maxLen) + '...';
      }

      /**
       * Get display text for tree node (returns HTML string).
       */
      function getTreeNodeDisplayHtml(entry, label) {
        const normalize = s => String(s ?? '').replace(/[\n\t]/g, ' ').trim();
        const labelHtml = label ? `<span class="tree-label">[${escapeHtml(label)}]</span> ` : '';

        switch (entry.type) {
          case 'message': {
            const msg = entry.message;
            if (msg.role === 'user') {
              const content = truncate(normalize(extractContent(msg.content)));
              return labelHtml + `<span class="tree-role-user">user:</span> ${escapeHtml(content)}`;
            }
            if (msg.role === 'assistant') {
              const textContent = truncate(normalize(extractContent(msg.content)));
              if (textContent) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> ${escapeHtml(textContent)}`;
              }
              if (msg.stopReason === 'aborted') {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(aborted)</span>`;
              }
              if (msg.errorMessage) {
                return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-error">${escapeHtml(truncate(msg.errorMessage))}</span>`;
              }
              return labelHtml + `<span class="tree-role-assistant">assistant:</span> <span class="tree-muted">(no text)</span>`;
            }
            if (msg.role === 'toolResult') {
              const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : null;
              if (toolCall) {
                return labelHtml + `<span class="tree-role-tool">${escapeHtml(formatToolCall(toolCall.name, toolCall.arguments))}</span>`;
              }
              return labelHtml + `<span class="tree-role-tool">[${escapeHtml(msg.toolName || 'tool')}]</span>`;
            }
            if (msg.role === 'bashExecution') {
              const cmd = truncate(normalize(msg.command || ''));
              return labelHtml + `<span class="tree-role-tool">[bash]:</span> ${escapeHtml(cmd)}`;
            }
            return labelHtml + `<span class="tree-muted">[${escapeHtml(msg.role)}]</span>`;
          }
          case 'compaction':
            return labelHtml + `<span class="tree-compaction">[compaction: ${Math.round(finiteNumber(entry.tokensBefore)/1000)}k tokens]</span>`;
          case 'branch_summary': {
            const summary = truncate(normalize(entry.summary || ''));
            return labelHtml + `<span class="tree-branch-summary">[branch summary]:</span> ${escapeHtml(summary)}`;
          }
          case 'custom_message': {
            const content = typeof entry.content === 'string' ? entry.content : extractContent(entry.content);
            return labelHtml + `<span class="tree-custom">[${escapeHtml(entry.customType)}]:</span> ${escapeHtml(truncate(normalize(content)))}`;
          }
          case 'model_change':
            return labelHtml + `<span class="tree-muted">[model: ${escapeHtml(entry.modelId)}]</span>`;
          case 'thinking_level_change':
            return labelHtml + `<span class="tree-muted">[thinking: ${escapeHtml(entry.thinkingLevel)}]</span>`;
          default:
            return labelHtml + `<span class="tree-muted">[${escapeHtml(entry.type)}]</span>`;
        }
      }

      // ============================================================
      // TREE RENDERING (DOM manipulation)
      // ============================================================

      let currentLeafId = leafId;
      let currentTargetId = urlTargetId || leafId;
      let treeRendered = false;

      function renderTree() {
        const tree = buildTree();
        const activePathIds = buildActivePathIds(currentLeafId);
        const flatNodes = flattenTree(tree, activePathIds);
        const filtered = filterNodes(flatNodes, currentLeafId);
        const container = document.getElementById('tree-container');

        // Full render only on first call or when filter/search changes
        if (!treeRendered) {
          container.innerHTML = '';

          for (const flatNode of filtered) {
            const entry = flatNode.node.entry;
            const isOnPath = activePathIds.has(entry.id);
            const isTarget = entry.id === currentTargetId;

            const div = document.createElement('div');
            div.className = 'tree-node';
            if (isOnPath) div.classList.add('in-path');
            if (isTarget) div.classList.add('active');
            div.dataset.id = entry.id;
            div.setAttribute('role', 'button');
            div.tabIndex = isTarget ? 0 : -1;
            if (isTarget) div.setAttribute('aria-current', 'true');

            const prefix = buildTreePrefix(flatNode);
            const prefixSpan = document.createElement('span');
            prefixSpan.className = 'tree-prefix';
            prefixSpan.textContent = prefix;
            prefixSpan.setAttribute('aria-hidden', 'true');

            const marker = document.createElement('span');
            marker.className = 'tree-marker';
            marker.textContent = isOnPath ? '•' : ' ';
            marker.setAttribute('aria-hidden', 'true');

            const content = document.createElement('span');
            content.className = 'tree-content';
            content.innerHTML = getTreeNodeDisplayHtml(entry, flatNode.node.label);

            div.appendChild(prefixSpan);
            div.appendChild(marker);
            div.appendChild(content);
            div.title = content.textContent;
            // Navigate to the newest leaf through this node, but scroll to the clicked node
            div.addEventListener('click', () => {
              if (window.getSelection().toString()) return;
              const leafId = findNewestLeaf(entry.id);
              navigateTo(leafId, 'target', entry.id);
              if (isMobileLayout()) closeSidebar();
            });

            container.appendChild(div);
          }

          treeRendered = true;
        } else {
          // Just update markers and classes
          const nodes = container.querySelectorAll('.tree-node');
          for (const node of nodes) {
            const id = node.dataset.id;
            const isOnPath = activePathIds.has(id);
            const isTarget = id === currentTargetId;

            node.classList.toggle('in-path', isOnPath);
            node.classList.toggle('active', isTarget);
            node.tabIndex = isTarget ? 0 : -1;
            if (isTarget) node.setAttribute('aria-current', 'true');
            else node.removeAttribute('aria-current');

            const marker = node.querySelector('.tree-marker');
            if (marker) {
              marker.textContent = isOnPath ? '•' : ' ';
            }
          }
        }

        const firstNode = container.querySelector('.tree-node');
        if (firstNode && !container.querySelector('.tree-node[tabindex="0"]')) firstNode.tabIndex = 0;
        if (!filtered.length) {
          container.innerHTML = '<div class="tree-empty"><strong>No matching entries</strong>Try a different search or choose All.</div>';
        }

        document.getElementById('tree-status').textContent = `${filtered.length} / ${flatNodes.length} entries`;

        // Scroll active node into view after layout
        setTimeout(() => {
          const activeNode = container.querySelector('.tree-node.active');
          if (activeNode) {
            activeNode.scrollIntoView({ block: 'nearest' });
          }
        }, 0);
      }

      function forceTreeRerender() {
        treeRendered = false;
        renderTree();
      }

      // ============================================================
      // MESSAGE RENDERING
      // ============================================================

      function formatTokens(count) {
        if (count < 1000) return count.toString();
        if (count < 10000) return (count / 1000).toFixed(1) + 'k';
        if (count < 1000000) return Math.round(count / 1000) + 'k';
        return (count / 1000000).toFixed(1) + 'M';
      }

      function formatTimestamp(ts) {
        if (!ts) return '';
        const date = new Date(ts);
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }

      function replaceTabs(text) {
        return String(text ?? '').replace(/\t/g, '   ');
      }

      function sanitizeToolHtml(html) {
        const template = document.createElement('template');
        template.innerHTML = String(html ?? '');
        const allowedTags = new Set(['DIV', 'SPAN', 'PRE', 'CODE', 'BR', 'B', 'STRONG', 'I', 'EM']);
        for (const el of template.content.querySelectorAll('*')) {
          if (!allowedTags.has(el.tagName)) {
            el.replaceWith(document.createTextNode(el.textContent));
            continue;
          }
          const classes = Array.from(el.classList).filter(name => /^(ansi-|hljs|diff-)[a-z0-9_-]*$/i.test(name));
          const color = el.style.color;
          const background = el.style.backgroundColor;
          for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
          if (classes.length) el.className = classes.join(' ');
          if (/^(#[\da-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(color)) el.style.color = color;
          if (/^(#[\da-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(background)) el.style.backgroundColor = background;
        }
        return template.innerHTML;
      }

      /** Safely coerce value to string for display. Returns null if invalid type. */
      function str(value) {
        if (typeof value === 'string') return value;
        if (value == null) return '';
        return null;
      }

      function getLanguageFromPath(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        const extToLang = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
          c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
          php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
          sql: 'sql', html: 'html', css: 'css', scss: 'scss',
          json: 'json', yaml: 'yaml', yml: 'yaml', xml: 'xml',
          md: 'markdown', dockerfile: 'dockerfile'
        };
        return extToLang[ext];
      }

      function findToolResult(toolCallId) {
        for (const entry of entries) {
          if (entry.type === 'message' && entry.message.role === 'toolResult') {
            if (entry.message.toolCallId === toolCallId) {
              return entry.message;
            }
          }
        }
        return null;
      }

      function formatExpandableOutput(text, maxLines, lang) {
        text = replaceTabs(text);
        const lines = text.split('\n');
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;

        if (lang) {
          let highlighted;
          try {
            highlighted = hljs.highlight(text, { language: lang }).value;
          } catch {
            highlighted = escapeHtml(text);
          }

          if (remaining > 0) {
            const previewCode = displayLines.join('\n');
            let previewHighlighted;
            try {
              previewHighlighted = hljs.highlight(previewCode, { language: lang }).value;
            } catch {
              previewHighlighted = escapeHtml(previewCode);
            }

            return `<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
              <div class="output-preview"><pre><code class="hljs">${previewHighlighted}</code></pre>
              <div class="expand-hint">... (${remaining} more lines)</div></div>
              <div class="output-full"><pre><code class="hljs">${highlighted}</code></pre></div></div>`;
          }

          return `<div class="tool-output"><pre><code class="hljs">${highlighted}</code></pre></div>`;
        }

        // Plain text output
        if (remaining > 0) {
          let out = '<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle(\'expanded\')">';
          out += '<div class="output-preview">';
          for (const line of displayLines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += `<div class="expand-hint">... (${remaining} more lines)</div></div>`;
          out += '<div class="output-full">';
          for (const line of lines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
          }
          out += '</div></div>';
          return out;
        }

        let out = '<div class="tool-output">';
        for (const line of displayLines) {
          out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        out += '</div>';
        return out;
      }

      function renderToolCall(call) {
        const result = findToolResult(call.id);
        const isError = result?.isError || false;
        const statusClass = result ? (isError ? 'error' : 'success') : 'pending';

        const getResultText = () => {
          if (!result) return '';
          const textBlocks = result.content.filter(c => c.type === 'text');
          return textBlocks.map(c => c.text).join('\n');
        };

        const getResultImages = () => {
          if (!result) return [];
          return result.content.filter(c => c.type === 'image');
        };

        const renderResultImages = () => {
          const images = getResultImages();
          if (images.length === 0) return '';
          return '<div class="tool-images">' +
            images.map(img => renderAttachmentImage(img, 'tool-image')).join('') +
            '</div>';
        };

        let html = `<div class="tool-execution ${statusClass}">`;
        const args = call.arguments || {};
        const name = call.name;

        const invalidArg = '<span class="tool-error">[invalid arg]</span>';

        switch (name) {
          case 'bash': {
            const command = str(args.command);
            const cmdDisplay = command === null ? invalidArg : escapeHtml(command || '...');
            html += `<div class="tool-command">$ ${cmdDisplay}</div>`;
            if (result) {
              const output = getResultText().trim();
              if (output) html += formatExpandableOutput(output, 5);
            }
            break;
          }
          case 'read': {
            const filePath = str(args.file_path ?? args.path);
            const offset = args.offset;
            const limit = args.limit;

            let pathHtml = filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''));
            if (filePath !== null && (offset !== undefined || limit !== undefined)) {
              const startLine = offset ?? 1;
              const endLine = limit !== undefined ? startLine + limit - 1 : '';
              pathHtml += `<span class="line-numbers">:${escapeHtml(startLine)}${endLine ? '-' + escapeHtml(endLine) : ''}</span>`;
            }

            html += `<div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${pathHtml}</span></div>`;
            if (result) {
              html += renderResultImages();
              const output = getResultText();
              const lang = filePath ? getLanguageFromPath(filePath) : null;
              if (output) html += formatExpandableOutput(output, 10, lang);
            }
            break;
          }
          case 'write': {
            const filePath = str(args.file_path ?? args.path);
            const content = str(args.content);

            html += `<div class="tool-header"><span class="tool-name">write</span> <span class="tool-path">${filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''))}</span>`;
            if (content !== null && content) {
              const lines = content.split('\n');
              if (lines.length > 10) html += ` <span class="line-count">(${lines.length} lines)</span>`;
            }
            html += '</div>';

            if (content === null) {
              html += `<div class="tool-error">[invalid content arg - expected string]</div>`;
            } else if (content) {
              const lang = filePath ? getLanguageFromPath(filePath) : null;
              html += formatExpandableOutput(content, 10, lang);
            }
            if (result) {
              const output = getResultText().trim();
              if (output) html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
            }
            break;
          }
          case 'edit': {
            const filePath = str(args.file_path ?? args.path);
            html += `<div class="tool-header"><span class="tool-name">edit</span> <span class="tool-path">${filePath === null ? invalidArg : escapeHtml(shortenPath(filePath || ''))}</span></div>`;

            if (result?.details?.diff) {
              const diffLines = String(result.details.diff).split('\n');
              html += '<div class="tool-diff">';
              for (const line of diffLines) {
                const cls = line.match(/^\+/) ? 'diff-added' : line.match(/^-/) ? 'diff-removed' : 'diff-context';
                html += `<div class="${cls}">${escapeHtml(replaceTabs(line))}</div>`;
              }
              html += '</div>';
            } else if (result) {
              const output = getResultText().trim();
              if (output) html += `<div class="tool-output"><pre>${escapeHtml(output)}</pre></div>`;
            }
            break;
          }
          case 'ls': {
            const dirPath = str(args.path);
            const limit = args.limit;

            let pathHtml = dirPath === null ? invalidArg : escapeHtml(shortenPath(dirPath || '.'));
            if (limit !== undefined) {
              pathHtml += ` <span class="line-count">(limit ${escapeHtml(String(limit))})</span>`;
            }

            html += `<div class="tool-header"><span class="tool-name">ls</span> <span class="tool-path">${pathHtml}</span></div>`;
            if (result) {
              const output = getResultText().trim();
              if (output) html += formatExpandableOutput(output, 20);
            }
            break;
          }
          default: {
            // Check for pre-rendered custom tool HTML
            const rendered = renderedTools?.[call.id];
            if (rendered?.callHtml || rendered?.resultHtmlCollapsed || rendered?.resultHtmlExpanded) {
              // Custom tool with pre-rendered HTML from TUI renderer
              if (rendered.callHtml) {
                html += `<div class="tool-header ansi-rendered">${sanitizeToolHtml(rendered.callHtml)}</div>`;
              } else {
                html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
              }

              if (rendered.resultHtmlCollapsed && rendered.resultHtmlExpanded && rendered.resultHtmlCollapsed !== rendered.resultHtmlExpanded) {
                // Both collapsed and expanded differ - render expandable section
                html += `<div class="tool-output expandable ansi-rendered" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
                  <div class="output-preview">${sanitizeToolHtml(rendered.resultHtmlCollapsed)}</div>
                  <div class="output-full">${sanitizeToolHtml(rendered.resultHtmlExpanded)}</div>
                </div>`;
              } else if (rendered.resultHtmlExpanded) {
                // Only expanded exists (or collapsed is identical) - show directly
                html += `<div class="tool-output ansi-rendered">${sanitizeToolHtml(rendered.resultHtmlExpanded)}</div>`;
              } else if (result) {
                // No pre-rendered result HTML - fallback to JSON
                const output = getResultText();
                if (output) html += formatExpandableOutput(output, 10);
              }
            } else {
              // Fallback to JSON display (existing behavior)
              html += `<div class="tool-header"><span class="tool-name">${escapeHtml(name)}</span></div>`;
              html += `<div class="tool-output"><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;
              if (result) {
                const output = getResultText();
                if (output) html += formatExpandableOutput(output, 10);
              }
            }
          }
        }

        html += '</div>';
        return html;
      }

      /**
       * Download the session data as a JSONL file.
       * Reconstructs the original format: header line + entry lines.
       */
      window.downloadSessionJson = function() {
        // Build JSONL content: header first, then all entries
        const lines = [];
        if (header) {
          lines.push(JSON.stringify({ ...header, type: 'session' }));
        }
        let hasHeader = Boolean(header);
        for (const entry of originalEntries) {
          if (entry?.type === 'session' || entry?.type === 'header') {
            if (hasHeader) continue;
            lines.push(JSON.stringify({ ...entry, type: 'session' }));
            hasHeader = true;
            continue;
          }
          lines.push(JSON.stringify(entry));
        }
        const jsonlContent = lines.join('\n');

        // Create download
        const blob = new Blob([jsonlContent], { type: 'application/x-ndjson' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${header?.id || 'session'}.jsonl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      /**
       * Build a shareable URL for a specific message.
       * URL format: base?gistId&leafId=<leafId>&targetId=<entryId>
       */
      function buildShareUrl(entryId) {
        // Check for injected base URL (used when loaded in iframe via srcdoc)
        const baseUrlMeta = document.querySelector('meta[name="pi-share-base-url"]');
        const url = new URL(baseUrlMeta ? baseUrlMeta.content : window.location.href, window.location.href);
        // Preserve the local session ID and all existing viewer parameters.
        url.searchParams.set('leafId', currentLeafId || '');
        url.searchParams.set('targetId', entryId);
        return url.toString();
      }

      /**
       * Copy text to clipboard with visual feedback.
       * Uses navigator.clipboard with fallback to execCommand for HTTP contexts.
       */
      async function copyToClipboard(text, button) {
        let success = false;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            success = true;
          }
        } catch (err) {
          // Clipboard API failed, try fallback
        }

        // Fallback for HTTP or when Clipboard API is unavailable
        if (!success) {
          try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            success = document.execCommand('copy');
            document.body.removeChild(textarea);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        }

        if (success && button) {
          const originalHtml = button.innerHTML;
          button.innerHTML = '✓';
          button.classList.add('copied');
          setTimeout(() => {
            button.innerHTML = originalHtml;
            button.classList.remove('copied');
          }, 1500);
        }
        document.getElementById('reader-status').textContent = success
          ? 'Message link copied.' : 'Could not copy the link. Your browser may restrict clipboard access.';
      }

      /**
       * Render the copy-link button HTML for a message.
       */
      function renderCopyLinkButton(entryId) {
        return `<button class="copy-link-btn" data-entry-id="${escapeHtml(entryId)}" title="Copy link to this message" aria-label="Copy link to this message">
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
        </button>`;
      }

      function renderEntry(entry) {
        const ts = formatTimestamp(entry.timestamp);
        const tsHtml = ts ? `<div class="message-timestamp">${ts}</div>` : '';
        const entryId = `entry-${escapeHtml(entry.id)}`;
        const copyBtnHtml = renderCopyLinkButton(entry.id);

        if (entry.type === 'message') {
          const msg = entry.message;

          if (msg.role === 'user') {
            let html = `<div class="user-message" id="${entryId}">${copyBtnHtml}<div class="message-role">You</div>${tsHtml}`;
            const content = msg.content;

            if (Array.isArray(content)) {
              const images = content.filter(c => c.type === 'image');
              if (images.length > 0) {
                html += '<div class="message-images">';
                for (const img of images) {
                  html += renderAttachmentImage(img, 'message-image');
                }
                html += '</div>';
              }
            }

            const text = typeof content === 'string' ? content :
              content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (text.trim()) {
              html += `<div class="markdown-content">${safeMarkedParse(text)}</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'assistant') {
            let html = `<div class="assistant-message" id="${entryId}">${copyBtnHtml}<div class="message-role">Assistant</div>${tsHtml}`;

            for (const block of msg.content) {
              if (block.type === 'text' && block.text.trim()) {
                html += `<div class="assistant-text markdown-content">${safeMarkedParse(block.text)}</div>`;
              } else if (block.type === 'thinking' && block.thinking.trim()) {
                html += `<div class="thinking-block">
                  <div class="thinking-text">${escapeHtml(block.thinking)}</div>
                  <div class="thinking-collapsed">Thinking ...</div>
                </div>`;
              }
            }

            for (const block of msg.content) {
              if (block.type === 'toolCall') {
                html += renderToolCall(block);
              }
            }

            if (msg.stopReason === 'aborted') {
              html += '<div class="error-text">Aborted</div>';
            } else if (msg.stopReason === 'error') {
              html += `<div class="error-text">Error: ${escapeHtml(msg.errorMessage || 'Unknown error')}</div>`;
            }

            html += '</div>';
            return html;
          }

          if (msg.role === 'bashExecution') {
            const isError = msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null);
            let html = `<div class="tool-execution ${isError ? 'error' : 'success'}" id="${entryId}">${tsHtml}`;
            html += `<div class="tool-command">$ ${escapeHtml(msg.command)}</div>`;
            if (msg.output) html += formatExpandableOutput(msg.output, 10);
            if (msg.cancelled) {
              html += '<div style="color: var(--warning)">(cancelled)</div>';
            } else if (msg.exitCode !== 0 && msg.exitCode !== null) {
              html += `<div style="color: var(--error)">(exit ${escapeHtml(msg.exitCode)})</div>`;
            }
            html += '</div>';
            return html;
          }

          if (msg.role === 'toolResult') return '';
        }

        if (entry.type === 'model_change') {
          return `<div class="model-change" id="${entryId}">${tsHtml}Switched to model: <span class="model-name">${escapeHtml(entry.provider)}/${escapeHtml(entry.modelId)}</span></div>`;
        }

        if (entry.type === 'compaction') {
          return `<div class="compaction" id="${entryId}" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
            <div class="compaction-label">[compaction]</div>
            <div class="compaction-collapsed">Compacted from ${finiteNumber(entry.tokensBefore).toLocaleString()} tokens</div>
            <div class="compaction-content"><strong>Compacted from ${finiteNumber(entry.tokensBefore).toLocaleString()} tokens</strong>\n\n${escapeHtml(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'branch_summary') {
          return `<div class="branch-summary" id="${entryId}">${tsHtml}
            <div class="branch-summary-header">Branch Summary</div>
            <div class="markdown-content">${safeMarkedParse(entry.summary)}</div>
          </div>`;
        }

        if (entry.type === 'custom_message' && entry.display) {
          return `<div class="hook-message" id="${entryId}">${tsHtml}
            <div class="hook-type">[${escapeHtml(entry.customType)}]</div>
            <div class="markdown-content">${safeMarkedParse(typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content))}</div>
          </div>`;
        }

        return '';
      }

      // ============================================================
      // HEADER / STATS
      // ============================================================

      function computeStats(entryList) {
        let userMessages = 0, assistantMessages = 0, toolResults = 0;
        let customMessages = 0, compactions = 0, branchSummaries = 0, toolCalls = 0;
        const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        const models = new Set();

        for (const entry of entryList) {
          if (entry.type === 'message') {
            const msg = entry.message;
            if (msg.role === 'user') userMessages++;
            if (msg.role === 'assistant') {
              assistantMessages++;
              if (msg.model) models.add(msg.provider ? `${msg.provider}/${msg.model}` : msg.model);
              if (msg.usage) {
                tokens.input += finiteNumber(msg.usage.input);
                tokens.output += finiteNumber(msg.usage.output);
                tokens.cacheRead += finiteNumber(msg.usage.cacheRead);
                tokens.cacheWrite += finiteNumber(msg.usage.cacheWrite);
                if (msg.usage.cost) {
                  cost.input += finiteNumber(msg.usage.cost.input);
                  cost.output += finiteNumber(msg.usage.cost.output);
                  cost.cacheRead += finiteNumber(msg.usage.cost.cacheRead);
                  cost.cacheWrite += finiteNumber(msg.usage.cost.cacheWrite);
                }
              }
              toolCalls += msg.content.filter(c => c.type === 'toolCall').length;
            }
            if (msg.role === 'toolResult') toolResults++;
          } else if (entry.type === 'compaction') {
            compactions++;
          } else if (entry.type === 'branch_summary') {
            branchSummaries++;
          } else if (entry.type === 'custom_message') {
            customMessages++;
          }
        }

        return { userMessages, assistantMessages, toolResults, customMessages, compactions, branchSummaries, toolCalls, tokens, cost, models: Array.from(models) };
      }

      let globalStats = computeStats(entries);

      function finiteNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : 0;
      }

      function renderHeader() {
        const totalCost = globalStats.cost.input + globalStats.cost.output + globalStats.cost.cacheRead + globalStats.cost.cacheWrite;

        const tokenParts = [];
        if (globalStats.tokens.input) tokenParts.push(`↑${formatTokens(globalStats.tokens.input)}`);
        if (globalStats.tokens.output) tokenParts.push(`↓${formatTokens(globalStats.tokens.output)}`);
        if (globalStats.tokens.cacheRead) tokenParts.push(`R${formatTokens(globalStats.tokens.cacheRead)}`);
        if (globalStats.tokens.cacheWrite) tokenParts.push(`W${formatTokens(globalStats.tokens.cacheWrite)}`);

        const msgParts = [];
        if (globalStats.userMessages) msgParts.push(`${globalStats.userMessages} user`);
        if (globalStats.assistantMessages) msgParts.push(`${globalStats.assistantMessages} assistant`);
        if (globalStats.toolResults) msgParts.push(`${globalStats.toolResults} tool results`);
        if (globalStats.customMessages) msgParts.push(`${globalStats.customMessages} custom`);
        if (globalStats.compactions) msgParts.push(`${globalStats.compactions} compactions`);
        if (globalStats.branchSummaries) msgParts.push(`${globalStats.branchSummaries} branch summaries`);

        let html = `
          <div class="header">
            <div class="header-eyebrow">Conversation archive</div>
            <h1>${escapeHtml(header?.name || 'Session overview')}</h1>
            <div class="session-id">${escapeHtml(header?.id || 'Local session')}</div>
            <div class="help-bar">
              <span class="help-hint"><kbd>T</kbd> Thinking · <kbd>O</kbd> Tools · <kbd>/</kbd> Search</span>
              <div class="help-actions">
                <button type="button" class="header-toggle-btn" data-action="toggle-thinking" title="Toggle thinking (T)">Thinking</button>
                <button type="button" class="header-toggle-btn" data-action="toggle-tools" title="Toggle tool details (O)">Tool details</button>
                <button type="button" class="download-json-btn" onclick="downloadSessionJson()" title="Download session as JSONL">↓ JSONL</button>
                <button type="button" class="header-toggle-btn" data-action="toggle-theme" title="Switch color theme">Theme</button>
              </div>
            </div>
            <div class="header-info">
              <div class="info-item"><span class="info-label">Date:</span><span class="info-value">${header?.timestamp ? new Date(header.timestamp).toLocaleString() : 'unknown'}</span></div>
              <div class="info-item"><span class="info-label">Models:</span><span class="info-value">${escapeHtml(globalStats.models.join(', ') || 'unknown')}</span></div>
              <div class="info-item"><span class="info-label">Messages:</span><span class="info-value">${msgParts.join(', ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Tool Calls:</span><span class="info-value">${globalStats.toolCalls}</span></div>
              <div class="info-item"><span class="info-label">Tokens:</span><span class="info-value">${tokenParts.join(' ') || '0'}</span></div>
              <div class="info-item"><span class="info-label">Cost:</span><span class="info-value">$${totalCost.toFixed(3)}</span></div>
            </div>
          </div>`;

        // Render system prompt (user's base prompt, applies to all providers)
        if (typeof systemPrompt === 'string' && systemPrompt) {
          const lines = systemPrompt.split('\n');
          const previewLines = 10;
          if (lines.length > previewLines) {
            const preview = lines.slice(0, previewLines).join('\n');
            const remaining = lines.length - previewLines;
            html += `<div class="system-prompt expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle('expanded')">
              <div class="system-prompt-header">System Prompt</div>
              <div class="system-prompt-preview">${escapeHtml(preview)}</div>
              <div class="system-prompt-expand-hint">... (${remaining} more lines, click to expand)</div>
              <div class="system-prompt-full">${escapeHtml(systemPrompt)}</div>
            </div>`;
          } else {
            html += `<div class="system-prompt">
              <div class="system-prompt-header">System Prompt</div>
              <div class="system-prompt-full" style="display: block">${escapeHtml(systemPrompt)}</div>
            </div>`;
          }
        }

        if (Array.isArray(tools) && tools.length > 0) {
          html += `<div class="tools-list">
            <div class="tools-header">Available Tools</div>
            <div class="tools-content">
              ${tools.filter(t => t && typeof t === 'object').map(t => {
                const hasParams = t.parameters && typeof t.parameters === 'object' && t.parameters.properties && Object.keys(t.parameters.properties).length > 0;
                if (!hasParams) {
                  return `<div class="tool-item"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span></div>`;
                }
                const params = t.parameters;
                const properties = params.properties;
                const required = params.required || [];
                let paramsHtml = '';
                for (const [name, rawProp] of Object.entries(properties)) {
                  const prop = rawProp && typeof rawProp === 'object' ? rawProp : {};
                  const isRequired = required.includes(name);
                  const typeStr = prop.type || 'any';
                  const reqLabel = isRequired ? '<span class="tool-param-required">required</span>' : '<span class="tool-param-optional">optional</span>';
                  paramsHtml += `<div class="tool-param"><span class="tool-param-name">${escapeHtml(name)}</span> <span class="tool-param-type">${escapeHtml(typeStr)}</span> ${reqLabel}`;
                  if (prop.description) {
                    paramsHtml += `<div class="tool-param-desc">${escapeHtml(prop.description)}</div>`;
                  }
                  paramsHtml += `</div>`;
                }
                return `<div class="tool-item" onclick="if(window.getSelection().toString())return;this.classList.toggle('params-expanded')"><span class="tool-item-name">${escapeHtml(t.name)}</span> - <span class="tool-item-desc">${escapeHtml(t.description)}</span> <span class="tool-params-hint"></span><div class="tool-params-content">${paramsHtml}</div></div>`;
              }).join('')}
            </div>
          </div>`;
        }

        return html;
      }

      // ============================================================
      // NAVIGATION
      // ============================================================

      // Cache for rendered entry DOM nodes
      const entryCache = new Map();

      function renderEntryToNode(entry) {
        // Check cache first
        if (entryCache.has(entry.id)) {
          return entryCache.get(entry.id).cloneNode(true);
        }

        // Render to HTML string, then parse to node
        const html = renderEntry(entry);
        if (!html) return null;

        const template = document.createElement('template');
        template.innerHTML = html;
        const node = template.content.firstElementChild;

        // Cache the node
        if (node) {
          entryCache.set(entry.id, node.cloneNode(true));
        }
        return node;
      }

      function navigateTo(targetId, scrollMode = 'target', scrollToEntryId = null) {
        currentLeafId = targetId;
        currentTargetId = scrollToEntryId || targetId;
        const path = getPath(targetId);

        renderTree();

        document.getElementById('header-container').innerHTML = renderHeader();
        attachHeaderHandlers();

        // Build messages using cached DOM nodes
        const messagesEl = document.getElementById('messages');
        const fragment = document.createDocumentFragment();

        for (const entry of path) {
          const node = renderEntryToNode(entry);
          if (node) {
            fragment.appendChild(node);
          }
        }

        messagesEl.innerHTML = '';
        messagesEl.appendChild(fragment);
        if (!messagesEl.children.length) {
          messagesEl.innerHTML = '<div class="reader-empty"><strong>No messages in this branch yet</strong>Choose another entry in the navigation, or wait for the session to continue.</div>';
        }
        applyDisplayPreferences();
        enhanceExpanders();

        // Attach click handlers for copy-link buttons
        messagesEl.querySelectorAll('.copy-link-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const entryId = btn.dataset.entryId;
            const shareUrl = buildShareUrl(entryId);
            copyToClipboard(shareUrl, btn);
          });
        });

        // Use setTimeout(0) to ensure DOM is fully laid out before scrolling
        setTimeout(() => {
          const content = document.getElementById('content');
          if (scrollMode === 'bottom') {
            content.scrollTop = content.scrollHeight;
          } else if (scrollMode === 'target') {
            // If scrollToEntryId is provided, scroll to that specific entry
            const scrollTargetId = scrollToEntryId || targetId;
            const targetEl = document.getElementById(`entry-${scrollTargetId}`);
            if (targetEl) {
              targetEl.scrollIntoView({ block: 'center' });
              // Briefly highlight the target message
              if (scrollToEntryId) {
                targetEl.classList.add('highlight');
                setTimeout(() => targetEl.classList.remove('highlight'), 2000);
              }
            }
          }
        }, 0);
      }

      // ============================================================
      // INITIALIZATION
      // ============================================================

      // Configure marked with syntax highlighting and TUI-compatible HTML handling
      const strictStrikethroughRegex = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

      marked.use({
        breaks: true,
        gfm: true,
        tokenizer: {
          // Treat HTML-like input as plain text so tags are shown verbatim,
          // matching the TUI markdown renderer.
          html() {
            return undefined;
          },
          tag() {
            return undefined;
          },
          del(src) {
            const match = strictStrikethroughRegex.exec(src);
            if (!match) return undefined;
            return {
              type: 'del',
              raw: match[0],
              text: match[2],
              tokens: this.lexer.inlineTokens(match[2])
            };
          }
        },
        renderer: {
          html(token) {
            return escapeHtml(token.text || token.raw || '');
          },
          // Sanitize link URLs to prevent javascript:/vbscript:/data: XSS
          link(token) {
            const href = (token.href || '').trim();
            let allowed = false;
            try { allowed = ['http:', 'https:', 'mailto:', 'file:'].includes(new URL(href, window.location.href).protocol); } catch (_) {}
            if (!allowed) {
              return this.parser.parseInline(token.tokens);
            }
            let out = '<a href="' + escapeHtml(href) + '"';
            if (token.title) {
              out += ' title="' + escapeHtml(token.title) + '"';
            }
            out += ' target="_blank" rel="noopener noreferrer">' + this.parser.parseInline(token.tokens) + '</a>';
            return out;
          },
          // Sanitize image src URLs
          image(token) {
            return '<span class="image-blocked" title="Remote images are disabled to keep this session private and offline">Image not loaded' +
              (token.text ? ': ' + escapeHtml(token.text) : '') + ' · offline mode</span>';
          },
          // Code blocks: syntax highlight, no HTML escaping
          code(token) {
            const code = token.text;
            const lang = token.lang;
            let highlighted;
            if (lang && hljs.getLanguage(lang)) {
              try {
                highlighted = hljs.highlight(code, { language: lang }).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            } else {
              // Auto-detect language if not specified
              try {
                highlighted = hljs.highlightAuto(code).value;
              } catch {
                highlighted = escapeHtml(code);
              }
            }
            return `<pre><code class="hljs">${highlighted}</code></pre>`;
          },
          // Inline code: escape HTML
          codespan(token) {
            return `<code>${escapeHtml(token.text)}</code>`;
          }
        }
      });

      // Simple marked parse (escaping handled in renderers)
      function safeMarkedParse(text) {
        return marked.parse(String(text ?? ''));
      }

      // Search input
      const searchInput = document.getElementById('tree-search');
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        forceTreeRerender();
      });

      // Filter buttons
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.classList.contains('active')));
        btn.addEventListener('click', () => {
          document.querySelectorAll('.filter-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
          });
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
          filterMode = btn.dataset.filter;
          forceTreeRerender();
        });
      });

      // Sidebar toggle
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebar-overlay');
      const hamburger = document.getElementById('hamburger');
      const sidebarResizer = document.getElementById('sidebar-resizer');
      const SIDEBAR_WIDTH_STORAGE_KEY = 'pi-share:v1:sidebar-width';
      const MIN_CONTENT_WIDTH = 320;

      function isMobileLayout() {
        return window.matchMedia('(max-width: 900px)').matches;
      }

      function getSidebarBounds() {
        const rootStyles = getComputedStyle(document.documentElement);
        const minWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-min-width')) || 240;
        const maxWidth = parseFloat(rootStyles.getPropertyValue('--sidebar-max-width')) || 720;
        const viewportMaxWidth = window.innerWidth - MIN_CONTENT_WIDTH;
        return {
          minWidth,
          maxWidth: Math.max(minWidth, Math.min(maxWidth, viewportMaxWidth))
        };
      }

      function clampSidebarWidth(width) {
        const { minWidth, maxWidth } = getSidebarBounds();
        return Math.max(minWidth, Math.min(maxWidth, width));
      }

      function applySidebarWidth(width) {
        const value = Math.round(clampSidebarWidth(width));
        document.documentElement.style.setProperty('--sidebar-width', `${value}px`);
        const bounds = getSidebarBounds();
        sidebarResizer?.setAttribute('aria-valuenow', String(value));
        sidebarResizer?.setAttribute('aria-valuemin', String(bounds.minWidth));
        sidebarResizer?.setAttribute('aria-valuemax', String(bounds.maxWidth));
      }

      function loadSidebarWidth() {
        try {
          const raw = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
          if (raw === null) return null;
          const width = Number(raw);
          return Number.isFinite(width) ? width : null;
        } catch {
          return null;
        }
      }

      function saveSidebarWidth(width) {
        try {
          localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(clampSidebarWidth(width))));
        } catch {
          // Ignore storage failures (e.g. private browsing restrictions)
        }
      }

      function setupSidebarResize() {
        const savedWidth = loadSidebarWidth();
        if (savedWidth !== null) {
          applySidebarWidth(savedWidth);
        } else {
          applySidebarWidth(340);
        }

        if (!sidebarResizer) return;

        let cleanupDrag = null;

        const stopDrag = (pointerId) => {
          if (cleanupDrag) {
            cleanupDrag(pointerId);
            cleanupDrag = null;
          }
        };

        sidebarResizer.addEventListener('pointerdown', (e) => {
          if (isMobileLayout()) return;

          e.preventDefault();
          const startX = e.clientX;
          const startWidth = sidebar.getBoundingClientRect().width;
          document.body.classList.add('sidebar-resizing');
          sidebarResizer.setPointerCapture?.(e.pointerId);

          const onPointerMove = (event) => {
            applySidebarWidth(startWidth + (event.clientX - startX));
          };

          cleanupDrag = (pointerIdToRelease) => {
            document.body.classList.remove('sidebar-resizing');
            sidebarResizer.releasePointerCapture?.(pointerIdToRelease);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
            saveSidebarWidth(sidebar.getBoundingClientRect().width);
          };

          const onPointerUp = (event) => stopDrag(event.pointerId);
          const onPointerCancel = (event) => stopDrag(event.pointerId);

          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
          window.addEventListener('pointercancel', onPointerCancel);
        });

        sidebarResizer.addEventListener('dblclick', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(340);
          saveSidebarWidth(340);
        });

        sidebarResizer.addEventListener('keydown', (e) => {
          if (isMobileLayout()) return;
          const width = sidebar.getBoundingClientRect().width;
          const bounds = getSidebarBounds();
          const next = { ArrowLeft: width - 20, ArrowRight: width + 20, Home: bounds.minWidth, End: bounds.maxWidth }[e.key];
          if (next === undefined) return;
          e.preventDefault();
          applySidebarWidth(next);
          saveSidebarWidth(next);
        });

        window.addEventListener('resize', () => {
          if (isMobileLayout()) return;
          applySidebarWidth(sidebar.getBoundingClientRect().width);
        });
      }

      setupSidebarResize();

      function syncSidebarChrome() {
        const open = isMobileLayout() && sidebar.classList.contains('open');
        document.body.classList.toggle('sidebar-open', open);
        // Server actions live outside #content. Keep them out of the mobile
        // drawer's focus order as well as behind its visual overlay.
        document.querySelectorAll('.viewer-actions, .viewer-follow').forEach(el => { el.inert = open; });
      }

      const openSidebar = () => {
        sidebar.classList.add('open');
        overlay.classList.add('open');
        hamburger.style.display = 'none';
        hamburger.setAttribute('aria-expanded', 'true');
        syncSidebarChrome();
        if (isMobileLayout()) document.getElementById('content').inert = true;
        searchInput.focus();
      };
      hamburger.addEventListener('click', openSidebar);

      const closeSidebar = (restoreFocus = true) => {
        sidebar.classList.remove('open');
        overlay.classList.remove('open');
        hamburger.style.display = '';
        hamburger.setAttribute('aria-expanded', 'false');
        syncSidebarChrome();
        document.getElementById('content').inert = false;
        if (restoreFocus && isMobileLayout()) hamburger.focus();
      };

      overlay.addEventListener('click', closeSidebar);
      document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
      window.addEventListener('resize', () => {
        if (!isMobileLayout() && sidebar.classList.contains('open')) closeSidebar(false);
      });

      // Toggle states
      let thinkingExpanded = true;
      let toolOutputsExpanded = false;

      const applyDisplayPreferences = () => {
        document.querySelectorAll('.thinking-text').forEach(el => {
          el.style.display = thinkingExpanded ? '' : 'none';
        });
        document.querySelectorAll('.thinking-collapsed').forEach(el => {
          el.style.display = thinkingExpanded ? 'none' : 'block';
        });
        document.querySelector('[data-action="toggle-thinking"]')?.setAttribute('aria-pressed', String(thinkingExpanded));
        document.querySelector('[data-action="toggle-tools"]')?.setAttribute('aria-pressed', String(toolOutputsExpanded));
        document.querySelectorAll('.tool-output.expandable, .compaction').forEach(el => {
          el.classList.toggle('expanded', toolOutputsExpanded);
          el.setAttribute('aria-expanded', String(toolOutputsExpanded));
        });
      };

      const toggleThinking = () => {
        thinkingExpanded = !thinkingExpanded;
        applyDisplayPreferences();
      };
      const toggleToolOutputs = () => {
        toolOutputsExpanded = !toolOutputsExpanded;
        applyDisplayPreferences();
      };

      function updateThemeButton() {
        const button = document.querySelector('[data-action="toggle-theme"]');
        if (!button) return;
        const dark = document.documentElement.dataset.theme === 'dark';
        button.textContent = dark ? '☀ Light' : '☾ Dark';
        button.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      }

      function toggleTheme() {
        const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem('pi-sessions-theme', theme); } catch (_) {}
        updateThemeButton();
      }

      const systemTheme = matchMedia('(prefers-color-scheme: dark)');
      systemTheme.addEventListener?.('change', (e) => {
        let saved;
        try { saved = localStorage.getItem('pi-sessions-theme'); } catch (_) {}
        if (saved !== 'light' && saved !== 'dark') {
          document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
          updateThemeButton();
        }
      });
      window.addEventListener('storage', (e) => {
        if (e.key !== 'pi-sessions-theme') return;
        document.documentElement.dataset.theme = e.newValue === 'light' || e.newValue === 'dark'
          ? e.newValue : (systemTheme.matches ? 'dark' : 'light');
        updateThemeButton();
      });

      const attachHeaderHandlers = () => {
        document.querySelector('[data-action="toggle-thinking"]')?.addEventListener('click', toggleThinking);
        document.querySelector('[data-action="toggle-tools"]')?.addEventListener('click', toggleToolOutputs);
        document.querySelector('[data-action="toggle-theme"]')?.addEventListener('click', toggleTheme);
        updateThemeButton();
      };

      const isEditableTarget = (element) => {
        if (!element) return false;
        const tagName = element.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' || tagName === 'BUTTON') {
          return true;
        }
        return element.isContentEditable || Boolean(element.closest?.('[contenteditable="true"]'));
      };

      const expanderSelector = '.tool-output.expandable, .compaction, .system-prompt.expandable, .tool-item[onclick]';
      function enhanceExpanders() {
        document.querySelectorAll(expanderSelector).forEach(el => {
          el.tabIndex = 0;
          el.setAttribute('role', 'button');
          el.setAttribute('aria-label', el.classList.contains('tool-item') ? 'Toggle tool parameters' : 'Toggle details');
          el.setAttribute('aria-expanded', String(el.classList.contains('expanded') || el.classList.contains('params-expanded')));
        });
      }

      document.addEventListener('click', (e) => {
        const expander = e.target.closest?.(expanderSelector);
        if (expander) expander.setAttribute('aria-expanded', String(expander.classList.contains('expanded') || expander.classList.contains('params-expanded')));
      });

      // One tabbable entry keeps large session trees practical to navigate.
      const treeContainer = document.getElementById('tree-container');
      treeContainer.addEventListener('keydown', (e) => {
        const node = e.target.closest('.tree-node');
        if (!node) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          node.click();
          return;
        }
        const nodes = Array.from(treeContainer.querySelectorAll('.tree-node'));
        const index = nodes.indexOf(node);
        const nextIndex = { ArrowUp: Math.max(0, index - 1), ArrowDown: Math.min(nodes.length - 1, index + 1), Home: 0, End: nodes.length - 1 }[e.key];
        if (nextIndex === undefined) return;
        e.preventDefault();
        node.tabIndex = -1;
        nodes[nextIndex].tabIndex = 0;
        nodes[nextIndex].focus();
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown') return;
        const first = treeContainer.querySelector('.tree-node');
        if (first) { e.preventDefault(); first.focus(); }
      });

      const imageModal = document.getElementById('image-modal');
      const modalImage = document.getElementById('modal-image');
      const modalClose = document.getElementById('image-modal-close');
      let imageReturnFocus = null;
      function closeImage() {
        imageModal.hidden = true;
        modalImage.removeAttribute('src');
        document.getElementById('content').inert = false;
        sidebar.inert = false;
        imageReturnFocus?.focus();
      }
      function openImage(img) {
        imageReturnFocus = img;
        modalImage.src = img.src;
        modalImage.alt = img.alt || 'Session image attachment';
        imageModal.hidden = false;
        document.getElementById('content').inert = true;
        sidebar.inert = true;
        modalClose.focus();
      }
      document.addEventListener('click', (e) => {
        if (e.target.matches?.('.message-image, .tool-image')) openImage(e.target);
      });
      imageModal.addEventListener('click', (e) => { if (e.target === imageModal) closeImage(); });
      modalClose.addEventListener('click', closeImage);

      // Keyboard shortcuts
      document.addEventListener('keydown', (e) => {
        if (!imageModal.hidden) {
          if (e.key === 'Escape') { e.preventDefault(); closeImage(); }
          if (e.key === 'Tab') { e.preventDefault(); modalClose.focus(); }
          return;
        }
        if (e.key === 'Escape') {
          if (sidebar.classList.contains('open') && isMobileLayout()) {
            e.preventDefault();
            closeSidebar();
          } else if (document.activeElement === searchInput && searchInput.value) {
            e.preventDefault();
            searchInput.value = '';
            searchQuery = '';
            forceTreeRerender();
          }
          return;
        }

        if (e.key === 'Tab' && isMobileLayout() && sidebar.classList.contains('open')) {
          const focusable = Array.from(sidebar.querySelectorAll('button, input, [tabindex="0"]'));
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
        if (e.key === 'Enter' || e.key === ' ') {
          const target = e.target;
          if (target.matches?.('.message-image, .tool-image')) { e.preventDefault(); openImage(target); return; }
          if (target.matches?.(expanderSelector)) { e.preventDefault(); target.click(); return; }
        }

        if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;

        if (isEditableTarget(document.activeElement)) {
          return;
        }

        const key = e.key.toLowerCase();
        if (key === '/') {
          e.preventDefault();
          if (isMobileLayout()) openSidebar();
          else searchInput.focus();
        } else if (key === 't') {
          e.preventDefault();
          toggleThinking();
        } else if (key === 'o') {
          e.preventDefault();
          toggleToolOutputs();
        }
      });

      // Live updates use the same renderer as offline exports. Rebuild derived
      // state so completed tool results and new branches cannot become stale.
      let liveDefaultLeaf = byId.has(defaultLeafId) ? defaultLeafId : entries[entries.length - 1]?.id || null;
      window.updateSessionData = function(nextData, options = {}) {
        if (!nextData || !Array.isArray(nextData.entries)) return { added: 0, currentLeafId };
        const previousIds = new Set(byId.keys());
        const wasLatestBranch = !currentLeafId || currentLeafId === liveDefaultLeaf;
        const content = document.getElementById('content');
        const oldScrollTop = content.scrollTop;
        const contentTop = content.getBoundingClientRect().top;
        const anchor = Array.from(document.querySelectorAll('#messages > [id]'))
          .find(el => el.getBoundingClientRect().bottom > contentTop);
        const anchorId = anchor?.id;
        const anchorOffset = anchor ? anchor.getBoundingClientRect().top - contentTop : 0;
        const previousTargetId = currentTargetId;

        originalEntries = nextData.entries;
        entries = normalizeEntries(originalEntries);
        if (nextData.header && typeof nextData.header === 'object') header = nextData.header;
        if ('systemPrompt' in nextData) systemPrompt = nextData.systemPrompt;
        if ('tools' in nextData) tools = nextData.tools;
        if ('renderedTools' in nextData) renderedTools = nextData.renderedTools;
        defaultLeafId = nextData.leafId;
        rebuildLookups();
        treeNodeMap = null;
        treeRendered = false;
        entryCache.clear();
        globalStats = computeStats(entries);
        liveDefaultLeaf = byId.has(defaultLeafId) ? defaultLeafId : entries[entries.length - 1]?.id || null;

        // A paused reader must not jump to a newly-created sibling branch,
        // even if the previously selected leaf used to be the latest one.
        const showLatest = Boolean(options.forceLatest || (options.follow && wasLatestBranch));
        const nextLeaf = showLatest ? liveDefaultLeaf
          : byId.has(currentLeafId) ? findNewestLeaf(currentLeafId) : liveDefaultLeaf;
        const keepTarget = !options.forceLatest && !(options.follow && showLatest) && byId.has(previousTargetId);
        navigateTo(nextLeaf, 'none', keepTarget ? previousTargetId : nextLeaf);
        if (options.scrollToBottom && showLatest) {
          content.scrollTop = content.scrollHeight;
        } else {
          const replacement = anchorId ? document.getElementById(anchorId) : null;
          content.scrollTop = replacement
            ? content.scrollTop + replacement.getBoundingClientRect().top - contentTop - anchorOffset
            : oldScrollTop;
        }
        return {
          added: entries.filter(entry => !previousIds.has(entry.id)).length,
          currentLeafId,
          followingLatest: currentLeafId === liveDefaultLeaf
        };
      };

      document.title = `${header?.name || 'Session'} · pi sessions`;

      // Initial render
      // If URL has targetId, scroll to that specific message; otherwise stay at top
      if (leafId) {
        if (urlTargetId && byId.has(urlTargetId)) {
          // Deep link: navigate to leaf and scroll to target message
          navigateTo(leafId, 'target', urlTargetId);
        } else {
          navigateTo(leafId, 'none');
        }
      } else if (entries.length > 0) {
        // Fallback: use last entry if no leafId
        navigateTo(entries[entries.length - 1].id, 'none');
      } else {
        navigateTo(null, 'none');
        document.getElementById('messages').innerHTML = '<div class="reader-empty"><strong>This session is empty</strong>Messages will appear here when the session has content.</div>';
      }
    })();
