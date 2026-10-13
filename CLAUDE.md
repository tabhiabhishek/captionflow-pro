## graphify-plus Knowledge Graph

A detailed knowledge graph has been built for this project (278 nodes, 852 edges, 33 communities).

**IMPORTANT: Read graphify-out/GRAPH_REPORT.md FIRST before searching or reading files.**

### Available MCP tools (if connected):

**Start here:**
1. `graph_stats` — graph overview (30 tokens)
2. `community_summaries` — table of contents for the whole codebase (100-500 tokens)
3. `get_god_nodes` — main architectural hubs (100-200 tokens)

**Find things:**
4. `search_graph` — find nodes by meaning (50-200 tokens). Use `compact: true` for minimal output.
5. `get_file_summary` — describe a file WITHOUT reading source (50-100 tokens)
6. `nodes_in_file` — all nodes in a file (50-500 tokens)
7. `get_neighbors` — connections around a node (100-500 tokens)
8. `shortest_path` — how two concepts connect (200-500 tokens)
9. `get_community` — all nodes in a cluster (100-1000 tokens)

**Manage:**
10. `rebuild_graph` — rebuild after code changes
11. `diff_impact` — see how git changes affect the graph
12. `semantic_enrich` — enrich nodes with AI descriptions (FREE with Ollama)

### Token-saving workflow:
1. `community_summaries` → understand the codebase structure
2. `search_graph("topic", compact=true)` → find relevant nodes
3. `get_file_summary("file.py")` → decide if you need to read source
4. Only read the actual file when you need exact code lines