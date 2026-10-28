// dsh-session-merge browser half: adds a "合并会话 / Merge sessions" entry to the
// conversation composer dock. Clicking it opens a panel that lists the profile's
// existing sessions; pick any number, press merge, and the host concatenates their
// event streams into a brand-new session (see lib/index.js for the merge rules).
//
// Hand-written in the DSH client bundle format (no build step required).
window.__ModuleLoader__.load({
	id: "dsh-session-merge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const BTN_STYLE = {
			boxSizing: "border-box",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: "12px",
			lineHeight: "20px",
			padding: "4px 0 0",
			marginLeft: "12px",
			whiteSpace: "nowrap",
			cursor: "pointer",
			userSelect: "none",
			textDecoration: "underline dotted"
		};

		const OVERLAY = {
			position: "fixed",
			inset: "0",
			background: "rgba(0,0,0,0.42)",
			zIndex: 9999,
			display: "flex",
			alignItems: "center",
			justifyContent: "center"
		};

		const PANEL = {
			width: "min(760px, 92vw)",
			maxHeight: "82vh",
			display: "flex",
			flexDirection: "column",
			background: "var(--dsw-alias-bg-base, #fff)",
			color: "var(--dsw-alias-label-primary, #111)",
			borderRadius: "10px",
			boxShadow: "0 18px 48px rgba(0,0,0,0.28)",
			overflow: "hidden",
			fontSize: "13px"
		};

		function fmtTime(ts) {
			if (!ts) return "?";
			const d = new Date(ts);
			return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}

		function fmtSize(bytes) {
			if (typeof bytes !== "number" || bytes <= 0) return "?";
			if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
			if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
			return bytes + " B";
		}

		function rowStyle(selected) {
			return {
				display: "flex",
				alignItems: "flex-start",
				gap: "10px",
				padding: "8px 14px",
				borderBottom: "1px solid var(--dsw-alias-border-subtle, #eee)",
				background: selected ? "var(--dsw-alias-bg-selected, #eef5ff)" : "transparent",
				cursor: "pointer"
			};
		}

		const MergePanel = react.memo(function MergePanel(props) {
			const { onClose } = props;
			const [sessions, setSessions] = react.useState(null);
			const [selected, setSelected] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [result, setResult] = react.useState(null);
			const [filter, setFilter] = react.useState("");

			react.useEffect(() => {
				let cancelled = false;
				fetch("/dsh-session-merge/list", { cache: "no-store" })
					.then((r) => r.json())
					.then((d) => {
						if (cancelled) return;
						if (d && d.ok) {
							const list = (d.sessions || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
							setSessions(list);
						} else {
							setError((d && d.error) || "无法读取会话列表");
						}
					})
					.catch((e) => { if (!cancelled) setError(String((e && e.message) || e)); });
				return () => { cancelled = true; };
			}, []);

			const chosen = Object.keys(selected).filter((k) => selected[k]);
			const visible = (sessions || []).filter((s) => {
				if (!filter) return true;
				const q = filter.toLowerCase();
				return String(s.id).toLowerCase().includes(q) || String(s.cwd || "").toLowerCase().includes(q);
			});

			function toggle(id) {
				setSelected((prev) => {
					const next = { ...prev };
					if (next[id]) delete next[id];
					else next[id] = true;
					return next;
				});
			}

			function merge() {
				if (chosen.length === 0 || busy) return;
				setBusy(true);
				setError(null);
				setResult(null);
				fetch("/dsh-session-merge/merge", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sessionIds: chosen })
				})
					.then((r) => r.json())
					.then((d) => {
						if (d && d.ok) setResult(d);
						else setError((d && d.error) || "合并失败");
					})
					.catch((e) => setError(String((e && e.message) || e)))
					.finally(() => setBusy(false));
			}

			const header = react.createElement("div", {
				style: { padding: "14px 16px", borderBottom: "1px solid var(--dsw-alias-border-subtle, #eee)", display: "flex", alignItems: "center", gap: "12px" }
			},
				react.createElement("strong", { style: { fontSize: "14px" } }, "合并会话"),
				react.createElement("span", { style: { opacity: 0.65, fontSize: "12px" } }, "勾选任意多个历史会话，合并为一个新会话继续"),
				react.createElement("span", { style: { flex: 1 } }),
				react.createElement("button", {
					onClick: onClose,
					style: { border: "none", background: "transparent", color: "inherit", fontSize: "18px", cursor: "pointer", lineHeight: "20px" }
				}, "\u00d7")
			);

			const toolbar = react.createElement("div", {
				style: { padding: "10px 16px", display: "flex", gap: "10px", alignItems: "center", borderBottom: "1px solid var(--dsw-alias-border-subtle, #eee)" }
			},
				react.createElement("input", {
					value: filter,
					onChange: (e) => setFilter(e.target.value),
					placeholder: "按 id / 工作目录过滤…",
					style: { flex: 1, padding: "6px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-base, #ccc)", background: "transparent", color: "inherit", fontSize: "12px" }
				}),
				react.createElement("span", { style: { fontSize: "12px", opacity: 0.75 } }, "已选 " + chosen.length + " / 共 " + (sessions ? sessions.length : "…")),
				react.createElement("button", {
					onClick: merge,
					disabled: busy || chosen.length === 0,
					style: {
						padding: "6px 14px", borderRadius: "6px", border: "none", cursor: chosen.length && !busy ? "pointer" : "default",
						background: chosen.length && !busy ? "#2f6fed" : "#bbb", color: "#fff", fontSize: "12px", fontWeight: 600
					}
				}, busy ? "合并中…" : "合并 " + chosen.length + " 个会话")
			);

			const status = error
				? react.createElement("div", { style: { padding: "8px 16px", color: "#c0392b", fontSize: "12px" } }, "错误：" + error)
				: result
					? react.createElement("div", { style: { padding: "8px 16px", color: "#1e7e34", fontSize: "12px" } },
						"✅ 已创建合并会话：" + result.sessionId + "（" + result.eventCount + " 个事件，来自 " + result.sources.length + " 个会话）",
						react.createElement("div", { style: { opacity: 0.75, marginTop: "4px" } }, "刷新页面（或重启 app）后可在会话列表打开它；合并的是完整历史，可直接继续对话。"))
					: null;

			const list = react.createElement("div", { style: { overflowY: "auto", flex: 1 } },
				sessions === null
					? react.createElement("div", { style: { padding: "20px 16px", opacity: 0.7 } }, "读取会话列表…")
					: visible.length === 0
						? react.createElement("div", { style: { padding: "20px 16px", opacity: 0.7 } }, "没有匹配的会话")
						: visible.map((s) => react.createElement("div", {
							key: s.id,
							style: rowStyle(!!selected[s.id]),
							onClick: () => toggle(s.id)
						},
							react.createElement("input", {
								type: "checkbox",
								checked: !!selected[s.id],
								onChange: () => toggle(s.id),
								onClick: (e) => e.stopPropagation(),
								style: { marginTop: "2px" }
							}),
							react.createElement("div", { style: { minWidth: 0, flex: 1 } },
								react.createElement("div", { style: { fontFamily: "monospace", fontSize: "12px", wordBreak: "break-all" } }, s.id),
								react.createElement("div", { style: { fontSize: "11px", opacity: 0.65, marginTop: "2px" } },
									fmtTime(s.createdAt) + " · v" + s.version + " · " + fmtSize(s.sizeBytes) + (s.cwd ? " · " + s.cwd : ""))
							)
						))
			);

			return react.createElement("div", { style: OVERLAY, onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				react.createElement("div", { style: PANEL }, header, toolbar, status, list)
			);
		});

		const MergeEntry = react.memo(function MergeEntry() {
			const [open, setOpen] = react.useState(false);
			return react.createElement(react.Fragment, null,
				react.createElement("div", {
					"data-dsh-session-merge": true,
					style: BTN_STYLE,
					title: "把多个历史会话合并成一个新会话继续",
					onClick: () => setOpen(true)
				}, "合并会话"),
				open ? react.createElement(MergePanel, { onClose: () => setOpen(false) }) : null
			);
		});

		/** Client services required by this plugin. */
		const inject = ["slots", "locale", "connection"];

		/** Register the dock entry (order 103: right of the cost lines). */
		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "dsh-session-merge",
				order: 103,
				inject: () => ({})
			}, MergeEntry));
		}

		exports.MergeEntry = MergeEntry;
		exports.MergePanel = MergePanel;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
