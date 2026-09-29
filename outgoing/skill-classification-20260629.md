# 全量 Skill 分类说明

生成时间: 2026-06-29 Asia/Shanghai

## 1. 交接包

- 完整包路径: `/Users/wangdada/Desktop/A2A-agent连接/outgoing/wangdada-all-user-skills-20260629.tar.gz`
- 完整包根目录: `codex-skills/`, `agents-skills/`
- 完整包 SHA256: `0625b3e16600c9c770a825bddd7c45fd03c2a20a1a0aaeafb7ee209469edddef`
- 分类说明文件路径: `/Users/wangdada/Desktop/A2A-agent连接/outgoing/skill-classification-20260629.md`
- 打包策略: 包含两个用户 skill 根目录下的全部 skill；仅排除 `.git`、`__pycache__`、`.DS_Store`、`*.pyc`。

## 2. 数量总览

- 顶层 skill 条目: 213
- 顶层 skill 唯一显示名: 205
- 全部层级 `SKILL.md`: 741
- `.codex/skills` 顶层: 25，全部层级: 496
- `.agents/skills` 顶层: 188，全部层级: 245

## 3. 分类方法

分类依据顶层 skill 的目录名、frontmatter `name` / `description`、以及路径上下文。一个顶层 skill 只放入一个主类别；若用途交叉，优先放到最能决定使用场景的类别。741 个 `SKILL.md` 的完整索引用于定位，不再对每个嵌套副本强行分类。

## 4. 类别总览

| 类别 | 顶层数量 | 适用场景 |
|---|---:|---|
| A. Agent 协作 / Codex / GStack 工作流 | 3 | Codex/GStack 工作流、计划、评审、QA、上下文保存、部署与协作编排。 |
| B. 编程开发 / 架构 / 测试 | 10 | 写代码、搭框架、测试、API、MCP、插件、小程序开发和工程实现。 |
| C. UI / UX / Web / 产品设计 | 23 | 网页、产品界面、设计系统、体验评审和前端视觉原型。 |
| D. Figma / 设计工具链 | 8 | Figma 文件、设计稿生成、Code Connect、FigJam/Slides/Motion。 |
| E. 文档 / PDF / Office / 表格 | 13 | PDF、Word、Markdown、Excel、Google 文档/表格及文档生成。 |
| F. PPT / Slides / 演示文稿 | 14 | PPTX、Keynote、HTML slides、演示模板和季度回顾。 |
| G. 数据 / 研究 / 财务分析 | 23 | 数据报告、财经披露、人物观点记录、图表和研究工作流。 |
| H. 浏览器 / 抓取 / 网页资料 | 12 | 浏览器控制、网页抓取、截图、下载、网页转 Markdown。 |
| I. 图像生成 / 图片编辑 / 视觉资产 | 24 | 图片生成、修图、封面、信息图、海报、视觉卡片和图像工具。 |
| J. 视频 / 音频 / 动效 | 25 | 视频模板、剪辑、音频、配音、音乐、动效和 Remotion。 |
| K. 内容写作 / 社媒 / 发布 | 9 | 文章、翻译、社媒卡片、发布和内部沟通。 |
| L. 营销 / 广告 / 增长 | 9 | 广告创意、CRO、品牌指南、营销心理和增长素材。 |
| M. 中国平台 / 小程序 / 微信生态 | 16 | 微信、小程序、抖音、小红书、微博、公众号、中文平台工作流。 |
| Z. 其它 / 通用创意工具 | 24 | 暂未明显归入以上类别的通用或小众工具。 |

## 5. 按类别的顶层 Skill 明细

### A. Agent 协作 / Codex / GStack 工作流 (3)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `gstack` | `agents-skills` | `gstack` | \| |
| `skill-creator` | `agents-skills` | `skill-creator` | Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill... |
| `gstack` | `codex-skills` | `gstack` | \| |

### B. 编程开发 / 架构 / 测试 (10)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `flutter-animating-apps` | `agents-skills` | `flutter-animating-apps` | \| |
| `frontend-dev` | `agents-skills` | `frontend-dev` | \| |
| `frontend-skill` | `agents-skills` | `frontend-skill` | \| |
| `gsap-core` | `agents-skills` | `gsap-core` | \| |
| `gsap-react` | `agents-skills` | `gsap-react` | \| |
| `gsap-timeline` | `agents-skills` | `gsap-timeline` | \| |
| `release-skills` | `agents-skills` | `release-skills` | Universal release workflow. Auto-detects version files and changelogs. Supports Node.js, Python, Rust, Claude Plugin, GitHub Releases, annotated tags, historical release backfill, and generic projects. Use when user s... |
| `shader-dev` | `agents-skills` | `shader-dev` | \| |
| `threejs` | `agents-skills` | `threejs` | \| |
| `subagent-driven-development` | `codex-skills` | `subagent-driven-development` | Use when executing implementation plans with independent tasks in the current session |

### C. UI / UX / Web / 产品设计 (23)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `apple-hig` | `agents-skills` | `apple-hig` | \| |
| `artifacts-builder` | `agents-skills` | `artifacts-builder` | \| |
| `baoyu-electron-extract` | `agents-skills` | `baoyu-electron-extract` | Extracts resources and JavaScript from any installed Electron app (`.asar` bundle), restoring original sources from `.js.map` files when available or formatting minified code with Prettier otherwise. Use when user wan... |
| `claude-api` | `agents-skills` | `claude-api` | Build, debug, and optimize Claude API / Anthropic SDK apps. Apps built with this skill should include prompt caching. Also handles migrating existing Claude API code between Claude model versions (4.5 → 4.6, 4.6 → 4.7... |
| `design-consultation` | `agents-skills` | `design-consultation` | \| |
| `design-md` | `agents-skills` | `design-md` | \| |
| `design-review` | `agents-skills` | `design-review` | \| |
| `frontend-design` | `agents-skills` | `frontend-design` | \| |
| `login-flow` | `agents-skills` | `login-flow` | Mobile login and authentication flow screens |
| `mcp-builder` | `agents-skills` | `mcp-builder` | Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or service... |
| `plan-design-review` | `agents-skills` | `plan-design-review` | \| |
| `platform-design` | `agents-skills` | `platform-design` | \| |
| `shadcn-ui` | `agents-skills` | `shadcn-ui` | \| |
| `swiftui-design` | `agents-skills` | `swiftui-design` | \| |
| `theme-factory` | `agents-skills` | `theme-factory` | \| |
| `ui-skills` | `agents-skills` | `ui-skills` | \| |
| `web-artifacts-builder` | `agents-skills` | `web-artifacts-builder` | \| |
| `web-design-guidelines` | `agents-skills` | `web-design-guidelines` | \| |
| `dashboard` | `codex-skills` | `dashboard` | \| |
| `receiving-code-review` | `codex-skills` | `receiving-code-review` | Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or bli... |
| `using-superpowers` | `codex-skills` | `using-superpowers` | Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions |
| `verification-before-completion` | `codex-skills` | `verification-before-completion` | Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertion... |
| `web-prototype` | `codex-skills` | `web-prototype` | \| |

### D. Figma / 设计工具链 (8)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `figma-code-connect-components` | `agents-skills` | `figma-code-connect-components` | \| |
| `figma-create-design-system-rules` | `agents-skills` | `figma-create-design-system-rules` | \| |
| `figma-create-new-file` | `agents-skills` | `figma-create-new-file` | \| |
| `figma-generate-design` | `agents-skills` | `figma-generate-design` | \| |
| `figma-generate-library` | `agents-skills` | `figma-generate-library` | \| |
| `figma-implement-design` | `agents-skills` | `figma-implement-design` | \| |
| `figma-use` | `agents-skills` | `figma-use` | \| |
| `figma` | `codex-skills` | `figma` | Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task involves Figma URLs, node IDs, design-to-code imp... |

### E. 文档 / PDF / Office / 表格 (13)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `article-magazine` | `agents-skills` | `article-magazine` | Huashu / huashu-md-html-inspired magazine article layout for turning Markdown or notes into a polished long-form HTML essay. |
| `baoyu-danger-x-to-markdown` | `agents-skills` | `baoyu-danger-x-to-markdown` | Converts X (Twitter) tweets and articles to markdown with YAML front matter. Uses reverse-engineered API requiring user consent. Use when user mentions "X to markdown", "tweet to markdown", "save tweet", or provides x... |
| `baoyu-format-markdown` | `agents-skills` | `baoyu-format-markdown` | Formats plain text or markdown files with frontmatter, titles, summaries, headings, bold, lists, and code blocks. Use when user asks to "format markdown", "beautify article", "add formatting", or improve article layou... |
| `baoyu-translate` | `agents-skills` | `baoyu-translate` | Translates articles and documents between languages with three modes - quick (direct), normal (analyze then translate), and refined (analyze, translate, review, polish). Supports custom glossaries and terminology cons... |
| `docx` | `agents-skills` | `docx` | \| |
| `minimax-docx` | `agents-skills` | `minimax-docx` | \| |
| `minimax-pdf` | `agents-skills` | `minimax-pdf` | \| |
| `obsidian-markdown` | `agents-skills` | `obsidian-markdown` | Create and edit Obsidian Flavored Markdown with wikilinks, embeds, callouts, properties, and other Obsidian-specific syntax. Use when working with .md files in Obsidian, or when the user mentions wikilinks, callouts,... |
| `pdf` | `agents-skills` | `pdf` | \| |
| `resume-modern` | `agents-skills` | `resume-modern` | Modern minimal resume, single A4 page, ready for print or PDF export. |
| `vfx-text-cursor` | `agents-skills` | `vfx-text-cursor` | Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros. |
| `baoyu-translate` | `codex-skills` | `baoyu-translate` | Translates articles and documents between languages with three modes - quick (direct), normal (analyze then translate), and refined (analyze, translate, review, polish). Supports custom glossaries and terminology cons... |
| `vibe-coding-workflow` | `codex-skills` | `vibe-coding-workflow` | Apply the EnzeD vibe-coding workflow to a new or existing game/app project. Use when Codex needs to turn an idea into a game design document or PRD, choose a simple robust tech stack, create a stepwise implementation... |

### F. PPT / Slides / 演示文稿 (14)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `baoyu-slide-deck` | `agents-skills` | `baoyu-slide-deck` | Generates professional slide deck images from content. Creates outlines with style instructions, then generates individual slide images. Use when user asks to "create slides", "make a presentation", "generate deck", "... |
| `deck-guizang-editorial` | `agents-skills` | `deck-guizang-editorial` | Editorial magazine meets e-ink: 10 layouts and 5 palettes (Ink, Indigo Porcelain, Forest Ink, Kraft Paper, Dune). |
| `deck-open-slide-canvas` | `agents-skills` | `deck-open-slide-canvas` | Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template. |
| `deck-swiss-international` | `agents-skills` | `deck-swiss-international` | 16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange). |
| `frontend-slides` | `agents-skills` | `frontend-slides` | \| |
| `guizang-ppt-skill` | `agents-skills` | `guizang-ppt-skill` | 生成横向翻页网页 PPT（单 HTML 文件），含 WebGL 背景、章节幕封、数据大字报、图片网格等模板。提供两种风格：① "电子杂志 × 电子墨水"（衬线 + 流体背景 + 暖色） ② "瑞士国际主义"（无衬线 + 网格点阵 + IKB/柠檬黄/柠檬绿/安全橙高亮）。当用户需要制作分享 / 演讲 / 发布会风格的网页 PPT，或提到"杂志风 PPT"、"瑞士风 PPT"、"Swiss Style"、"horizontal sw... |
| `html-ppt-retro-quarterly-review` | `agents-skills` | `html-ppt-retro-quarterly-review` | \| |
| `nanobanana-ppt` | `agents-skills` | `nanobanana-ppt` | \| |
| `ppt-keynote` | `agents-skills` | `ppt-keynote` | Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation. |
| `pptx` | `agents-skills` | `pptx` | \| |
| `pptx-generator` | `agents-skills` | `pptx-generator` | \| |
| `pptx-html-fidelity-audit` | `agents-skills` | `pptx-html-fidelity-audit` | Audit a python-pptx export against its source HTML deck, identify layout/content drift (footer overflow, cropped content, missing italic/em, lost styling, off-rhythm spacing), and re-export with strict footer-rail + c... |
| `slides` | `agents-skills` | `slides` | \| |
| `magazine-web-ppt` | `codex-skills` | `guizang-ppt` | 生成"电子杂志 × 电子墨水"风格的横向翻页网页 PPT（单 HTML 文件），含 WebGL 流体背景、衬线标题 + 非衬线正文、章节幕封、数据大字报、图片网格等模板。当用户需要制作分享 / 演讲 / 发布会风格的网页 PPT，或提到"杂志风 PPT"、"horizontal swipe deck"、"editorial magazine"、"e-ink presentation"时使用。 |

### G. 数据 / 研究 / 财务分析 (23)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `baoyu-article-illustrator` | `agents-skills` | `baoyu-article-illustrator` | Analyzes article structure, identifies positions requiring visual aids, generates illustrations with Type × Style × Palette three-dimension approach. Use when user asks to "illustrate article", "add images", "generate... |
| `baoyu-comic` | `agents-skills` | `baoyu-comic` | Knowledge comic creator supporting multiple art styles and tones. Creates original educational comics with detailed panel layouts and batch-capable image generation. Use when user asks to create "知识漫画", "教育漫画", "biogr... |
| `baoyu-danger-gemini-web` | `agents-skills` | `baoyu-danger-gemini-web` | Generates images and text via reverse-engineered Gemini Web API. Supports text generation, image generation from prompts, reference images for vision input, and multi-turn conversations. Use when other skills need ima... |
| `baoyu-diagram` | `agents-skills` | `baoyu-diagram` | Create professional, dark-themed SVG diagrams of any type — architecture diagrams, flowcharts, sequence diagrams, structural diagrams, mind maps, timelines, illustrative/conceptual diagrams, and more. Use this skill w... |
| `baoyu-image-gen` | `agents-skills` | `baoyu-image-gen` | AI image generation with OpenAI GPT Image 2, Azure OpenAI, Google, OpenRouter, DashScope, Z.AI GLM-Image, MiniMax, Jimeng, Seedream and Replicate APIs. Supports text-to-image, reference images, aspect ratios, and batc... |
| `ckm:design` | `agents-skills` | `ckm-design` | Comprehensive design skill: brand identity, design tokens, UI styling, logo generation (55 styles, Gemini AI), corporate identity program (50 deliverables, CIP mockups), HTML presentations (Chart.js), banner design (2... |
| `ckm:design-system` | `agents-skills` | `ckm-design-system` | Token architecture, component specifications, and slide generation. Three-layer tokens (primitive→semantic→component), CSS variables, spacing/typography scales, component specs, strategic slide creation. Use for desig... |
| `ckm:slides` | `agents-skills` | `ckm-slides` | Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies. |
| `d3-visualization` | `agents-skills` | `d3-visualization` | \| |
| `data-report` | `agents-skills` | `data-report` | Turns CSV, Excel, or JSON data into a polished visual report page. |
| `doc-coauthoring` | `agents-skills` | `doc-coauthoring` | Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users... |
| `frame-data-chart-nyt` | `agents-skills` | `frame-data-chart-nyt` | NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band). |
| `frame-flowchart-sticky` | `agents-skills` | `frame-flowchart-sticky` | SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel. |
| `hatch-pet` | `agents-skills` | `hatch-pet` | Create, repair, validate, preview, and package Codex-compatible animated pet spritesheets from character art, screenshots, generated images, or visual references. Use when a user wants to hatch a Codex pet, create a c... |
| `json-canvas` | `agents-skills` | `json-canvas` | Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections. Use when working with .canvas files, creating visual canvases, mind maps, flowcharts, or when the user mentions Canvas files in O... |
| `obsidian-bases` | `agents-skills` | `obsidian-bases` | Create and edit Obsidian Bases (.base files) with views, filters, formulas, and summaries. Use when working with .base files, creating database-like views of notes, or when the user mentions Bases, table views, card v... |
| `obsidian-cli` | `agents-skills` | `obsidian-cli` | Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Also supports plugin and theme development with commands to reload plugins, run JavaScript,... |
| `swiss-user-research-video-template` | `agents-skills` | `swiss-user-research-video-template` | \| |
| `ui-ux-pro-max` | `agents-skills` | `ui-ux-pro-max` | UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types across 10 stacks (React, Next.js, Vue, Svelte, SwiftUI,... |
| `xlsx` | `agents-skills` | `xlsx` | Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, comp... |
| `financial-report-pro` | `codex-skills` | `financial-report-pro` | Local Codex skill for cross-market financial report and disclosure analysis. Use for Chinese listed-company reports, US SEC EDGAR filings, 10-K, 10-Q, 8-K, DEF 14A, Form 4, 13F, SC 13D/G, PDF/text/HTML/JSON extraction... |
| `person-track-record-research` | `codex-skills` | `person-track-record-research` | Evidence-first research workflow for evaluating a person's historical viewpoints, predictions, claim accuracy, viewpoint changes, and domain-specific credibility. Use when asked to study whether a person, thinker, inv... |
| `ui-ux-pro-max` | `codex-skills` | `ui-ux-pro-max` | UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types across 10 stacks (React, Next.js, Vue, Svelte, SwiftUI,... |

### H. 浏览器 / 抓取 / 网页资料 (12)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `agent-browser` | `agents-skills` | `agent-browser` | \| |
| `baoyu-post-to-x` | `agents-skills` | `baoyu-post-to-x` | Posts content and articles to X (Twitter). Supports regular posts with images/videos and X Articles (long-form Markdown). In Codex, honor explicit requests for the Codex Chrome plugin/@chrome by using the Chrome Exten... |
| `baoyu-url-to-markdown` | `agents-skills` | `baoyu-url-to-markdown` | Fetch any URL and convert to markdown using baoyu-fetch CLI (Chrome CDP with site-specific adapters). Built-in adapters for X/Twitter, YouTube transcripts, Hacker News threads, and generic pages via Defuddle. Handles... |
| `baoyu-youtube-transcript` | `agents-skills` | `baoyu-youtube-transcript` | Downloads YouTube video transcripts/subtitles and cover images by URL or video ID. Supports multiple languages, translation, chapters, and speaker identification. Caches raw data for fast re-formatting. Use when user... |
| `defuddle` | `agents-skills` | `defuddle` | Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL to read or analyze, for online documentation, arti... |
| `doc-kami-parchment` | `agents-skills` | `doc-kami-parchment` | Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography. |
| `full-page-screenshot` | `agents-skills` | `full-page-screenshot` | \| |
| `screenshot` | `agents-skills` | `screenshot` | \| |
| `screenshots-marketing` | `agents-skills` | `screenshots-marketing` | \| |
| `video-downloader` | `agents-skills` | `video-downloader` | \| |
| `webapp-testing` | `agents-skills` | `webapp-testing` | Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs. |
| `embedded-screenshot-text-editor` | `codex-skills` | `embedded-screenshot-text-editor` | Edit text inside screenshots embedded in legacy Word .doc files, especially terminal screenshots, network-lab screenshots, Wi-Fi/Phone UI screenshots, and mixed PNG/JPEG OLE Data streams. Use when asked to replace IDs... |

### I. 图像生成 / 图片编辑 / 视觉资产 (24)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `baoyu-compress-image` | `agents-skills` | `baoyu-compress-image` | Compresses images to WebP (default) or PNG with automatic tool selection. Use when user asks to "compress image", "optimize image", "convert to webp", or reduce image file size. |
| `baoyu-cover-image` | `agents-skills` | `baoyu-cover-image` | Generates article cover images with 5 dimensions (type, palette, rendering, text, mood) combining 11 color palettes and 7 rendering styles. Supports cinematic (2.35:1), widescreen (16:9), and square (1:1) aspects. Use... |
| `baoyu-infographic` | `agents-skills` | `baoyu-infographic` | Generate professional infographics with 21 layout types and 22 visual styles. Analyzes content, recommends layout×style combinations, and generates publication-ready infographics. Use when user asks to create "infogra... |
| `canvas-design` | `agents-skills` | `canvas-design` | \| |
| `ckm:banner-design` | `agents-skills` | `ckm-banner-design` | Design banners for social media, ads, website heroes, creative assets, and print. Multiple art direction options with AI-generated visuals. Actions: design, create, generate banner. Platforms: Facebook, Twitter/X, Lin... |
| `ckm:ui-styling` | `agents-skills` | `ckm-ui-styling` | Create beautiful, accessible user interfaces with shadcn/ui components (built on Radix UI + Tailwind), Tailwind CSS utility-first styling, and canvas-based visual designs. Use when building user interfaces, implementi... |
| `fal-image-edit` | `agents-skills` | `fal-image-edit` | \| |
| `fal-restore` | `agents-skills` | `fal-restore` | \| |
| `fal-tryon` | `agents-skills` | `fal-tryon` | \| |
| `fal-upscale` | `agents-skills` | `fal-upscale` | \| |
| `fal-vision` | `agents-skills` | `fal-vision` | \| |
| `hand-drawn-diagrams` | `agents-skills` | `hand-drawn-diagrams` | \| |
| `image-enhancer` | `agents-skills` | `image-enhancer` | \| |
| `imagegen` | `agents-skills` | `imagegen` | \| |
| `imagen` | `agents-skills` | `imagen` | \| |
| `mockup-device-3d` | `agents-skills` | `mockup-device-3d` | Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition. |
| `pixelbin-media` | `agents-skills` | `pixelbin-media` | \| |
| `poster-hero` | `agents-skills` | `poster-hero` | Vertical poster or Moments-style share image with strong visual impact. |
| `venice-image-edit` | `agents-skills` | `venice-image-edit` | \| |
| `venice-image-generate` | `agents-skills` | `venice-image-generate` | \| |
| `baoyu-cover-image` | `codex-skills` | `baoyu-cover-image` | Generates article cover images with 5 dimensions (type, palette, rendering, text, mood) combining 11 color palettes and 7 rendering styles. Supports cinematic (2.35:1), widescreen (16:9), and square (1:1) aspects. Use... |
| `baoyu-infographic` | `codex-skills` | `baoyu-infographic` | Generate professional infographics with 21 layout types and 22 visual styles. Analyzes content, recommends layout×style combinations, and generates publication-ready infographics. Use when user asks to create "infogra... |
| `find-skills` | `codex-skills` | `find-skills` | Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be use... |
| `frontend-design` | `codex-skills` | `frontend-design` | Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, land... |

### J. 视频 / 音频 / 动效 (25)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `8-bit-orbit-video-template` | `agents-skills` | `8-bit-orbit-video-template` | \| |
| `ai-music-album` | `agents-skills` | `ai-music-album` | \| |
| `fal-kling-o3` | `agents-skills` | `fal-kling-o3` | \| |
| `fal-lip-sync` | `agents-skills` | `fal-lip-sync` | \| |
| `fal-video-edit` | `agents-skills` | `fal-video-edit` | \| |
| `frame-glitch-title` | `agents-skills` | `frame-glitch-title` | Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes. |
| `frame-light-leak-cinema` | `agents-skills` | `frame-light-leak-cinema` | Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards. |
| `frame-liquid-bg-hero` | `agents-skills` | `frame-liquid-bg-hero` | WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters. |
| `frame-logo-outro` | `agents-skills` | `frame-logo-outro` | Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames. |
| `frame-macos-notification` | `agents-skills` | `frame-macos-notification` | Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers. |
| `gif-sticker-maker` | `agents-skills` | `gif-sticker-maker` | \| |
| `huashu-design` | `agents-skills` | `huashu-design` | 花叔Design（Huashu-Design）——用HTML做高保真原型、交互Demo、幻灯片、动画、设计变体探索+设计方向顾问+专家评审的一体化设计能力。HTML是工具不是媒介，根据任务embody不同专家（UX设计师/动画师/幻灯片设计师/原型师），避免web design tropes。触发词：做原型、设计Demo、交互原型、HTML演示、动画Demo、设计变体、hi-fi设计、UI mockup、prototype、设计探... |
| `remotion` | `agents-skills` | `remotion` | \| |
| `slack-gif-creator` | `agents-skills` | `slack-gif-creator` | \| |
| `social-reddit-card` | `agents-skills` | `social-reddit-card` | Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing. |
| `social-spotify-card` | `agents-skills` | `social-spotify-card` | Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages. |
| `social-x-post-card` | `agents-skills` | `social-x-post-card` | Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards. |
| `sora` | `agents-skills` | `sora` | \| |
| `speech` | `agents-skills` | `speech` | \| |
| `stitch-loop` | `agents-skills` | `stitch-loop` | \| |
| `venice-audio-music` | `agents-skills` | `venice-audio-music` | \| |
| `venice-audio-speech` | `agents-skills` | `venice-audio-speech` | \| |
| `venice-video` | `agents-skills` | `venice-video` | \| |
| `video-hyperframes` | `agents-skills` | `video-hyperframes` | Hyperframes / Remotion-compatible continuous frame animation with autoplay support. |
| `youtube-clipper` | `agents-skills` | `youtube-clipper` | \| |

### K. 内容写作 / 社媒 / 发布 (9)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `after-hours-editorial-template` | `agents-skills` | `after-hours-editorial-template` | \| |
| `card-twitter` | `agents-skills` | `card-twitter` | Twitter quote or data card designed to pair with a post. |
| `copywriting` | `agents-skills` | `copywriting` | \| |
| `editorial-burgundy-principles-template` | `agents-skills` | `editorial-burgundy-principles-template` | \| |
| `field-notes-editorial-template` | `agents-skills` | `field-notes-editorial-template` | \| |
| `internal-comms` | `agents-skills` | `internal-comms` | A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (stat... |
| `release-notes-one-pager` | `agents-skills` | `release-notes-one-pager` | \| |
| `test-driven-development` | `codex-skills` | `test-driven-development` | Use when implementing any feature or bugfix, before writing implementation code |
| `writing-plans` | `codex-skills` | `writing-plans` | Use when you have a spec or requirements for a multi-step task, before touching code |

### L. 营销 / 广告 / 增长 (9)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `ad-creative` | `agents-skills` | `ad-creative` | \| |
| `brand-guidelines` | `agents-skills` | `brand-guidelines` | \| |
| `ckm:brand` | `agents-skills` | `ckm-brand` | Brand voice, visual identity, messaging frameworks, asset management, brand consistency. Activate for branded content, tone of voice, marketing assets, brand compliance, style guides. |
| `competitive-ads-extractor` | `agents-skills` | `competitive-ads-extractor` | \| |
| `creative-director` | `agents-skills` | `creative-director` | \| |
| `domain-name-brainstormer` | `agents-skills` | `domain-name-brainstormer` | \| |
| `gsap-scrolltrigger` | `agents-skills` | `gsap-scrolltrigger` | \| |
| `marketing-psychology` | `agents-skills` | `marketing-psychology` | \| |
| `paywall-upgrade-cro` | `agents-skills` | `paywall-upgrade-cro` | \| |

### M. 中国平台 / 小程序 / 微信生态 (16)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `auth-wechat-miniprogram` | `agents-skills` | `auth-wechat-miniprogram` | CloudBase WeChat Mini Program native authentication guide. This skill should be used when users need mini program identity handling, OPENID/UNIONID access, or `wx.cloud` auth behavior in projects where login is native... |
| `baoyu-markdown-to-html` | `agents-skills` | `baoyu-markdown-to-html` | Converts Markdown to styled HTML with WeChat-compatible themes. Supports code highlighting, math, Mermaid (rendered to PNG via headless Chrome), PlantUML, footnotes, alerts, infographics, and optional bottom citations... |
| `baoyu-post-to-wechat` | `agents-skills` | `baoyu-post-to-wechat` | Posts content to WeChat Official Account (微信公众号) via API or Chrome CDP. Supports article posting (文章) with HTML, markdown, or plain text input, and image-text posting (贴图, formerly 图文) with multiple images. Markdown a... |
| `baoyu-post-to-weibo` | `agents-skills` | `baoyu-post-to-weibo` | Posts content to Weibo (微博). Supports regular posts with text, images, and videos, and headline articles (头条文章) with Markdown input via Chrome CDP. Use when user asks to "post to Weibo", "发微博", "发布微博", "publish to Wei... |
| `baoyu-wechat-summary` | `agents-skills` | `baoyu-wechat-summary` | Summarizes WeChat group chat highlights into a structured digest using the local wx-cli binary (https://github.com/jackwener/wx-cli). Generates a normal digest by default; a roast (毒舌) version is opt-in. Maintains per... |
| `baoyu-xhs-images` | `agents-skills` | `baoyu-xhs-images` | Generates infographic image card series with 12 visual styles, 8 layouts, and 3 color palettes. Breaks content into 1-10 cartoon-style image cards optimized for social media engagement. Use when user mentions "小红书图片",... |
| `card-xiaohongshu` | `agents-skills` | `card-xiaohongshu` | Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel. |
| `douyin-video` | `agents-skills` | `douyin-video` | 抖音无水印视频下载和文案提取工具. 从抖音分享链接获取无水印视频下载链接, 下载视频, 提取视频中的语音文案并自动保存到文件. 适用场景包括获取抖音视频信息, 下载无水印视频, 批量提取视频文案. 当用户需要处理抖音视频链接或提取视频内容时触发. |
| `douyin-video-summary` | `agents-skills` | `douyin-video-summary` | Summarize Douyin (TikTok China) videos by extracting audio, transcribing with whisper.cpp, and generating structured summaries. Use when a user shares a Douyin link and wants a text summary of the video content. Suppo... |
| `miniprogram-development` | `agents-skills` | `miniprogram-development` | WeChat Mini Program development skill for building, debugging, previewing, testing, publishing, and optimizing mini program projects. This skill should be used when users ask to create, develop, modify, debug, preview... |
| `tencent-channel-community` | `agents-skills` | `tencent-channel-community` | 腾讯频道社区操作 skill,支持频道管理、内容管理与辅助运营,可用于创建和预览公开/私密频道、查看和修改频道资料、管理频道成员与子频道、搜索频道/帖子/作者并获取分享链接、浏览频道主页或指定版块帖子、查看帖子详情/评论/回复、查看互动消息通知、发帖改帖删帖、评论回复点赞、上传图片/视频/文件素材、内容巡检和频道问答自动回复。涉及腾讯频道、频道主页帖子、发帖删帖、评论回复、互动消息、频道成员、分享链接等任务时,应优先使用本 skill。 |
| `wechat-official-account-publisher` | `agents-skills` | `wechat-official-account-publisher` | Publish HTML articles into a WeChat Official Account draft box on this Mac. Use when the user asks to push an article to WeChat, upload a draft, publish to a WeChat Official Account, test the WeChat publishing workflo... |
| `weread-year-in-review-video-template` | `agents-skills` | `weread-year-in-review-video-template` | \| |
| `baoyu-image-cards` | `codex-skills` | `baoyu-image-cards` | Generates infographic image card series with 12 visual styles, 8 layouts, and 3 color palettes. Breaks content into 1-10 cartoon-style image cards optimized for social media engagement. Use when user mentions "小红书图片",... |
| `baoyu-markdown-to-html` | `codex-skills` | `baoyu-markdown-to-html` | Converts Markdown to styled HTML with WeChat-compatible themes. Supports code highlighting, math, PlantUML, footnotes, alerts, infographics, and optional bottom citations for external links. Use when user asks for "ma... |
| `wechat-official-account-publisher` | `codex-skills` | `wechat-official-account-publisher` | Publish HTML articles into a WeChat Official Account draft box on this Mac. Use when the user asks to push an article to WeChat, upload a draft, publish to a WeChat Official Account, test the WeChat publishing workflo... |

### Z. 其它 / 通用创意工具 (24)

| Skill | 来源 | 路径 | 说明 |
|---|---|---|---|
| `agently-mail` | `agents-skills` | `agently-mail` | 通过 agently-cli 命令行工具操作邮件：发送、回复、转发、搜索、读取、下载附件、管理收件箱。当用户需要进行任何邮件相关操作时使用此 skill。 |
| `algorithmic-art` | `agents-skills` | `algorithmic-art` | \| |
| `board-minutes` | `agents-skills` | `board-minutes` | > |
| `brainstorming` | `agents-skills` | `brainstorming` | \| |
| `closing-checklist` | `agents-skills` | `closing-checklist` | > |
| `color-expert` | `agents-skills` | `color-expert` | \| |
| `design-brief` | `agents-skills` | `design-brief` | \| |
| `digits-fintech-swiss-template` | `agents-skills` | `digits-fintech-swiss-template` | \| |
| `diligence-issue-extraction` | `agents-skills` | `diligence-issue-extraction` | > |
| `doc` | `agents-skills` | `doc` | \| |
| `enhance-prompt` | `agents-skills` | `enhance-prompt` | \| |
| `fal-3d` | `agents-skills` | `fal-3d` | \| |
| `fal-generate` | `agents-skills` | `fal-generate` | \| |
| `fal-realtime` | `agents-skills` | `fal-realtime` | \| |
| `fal-train` | `agents-skills` | `fal-train` | \| |
| `faq-page` | `agents-skills` | `faq-page` | \| |
| `material-contract-schedule` | `agents-skills` | `material-contract-schedule` | > |
| `replicate` | `agents-skills` | `replicate` | \| |
| `swiss-creative-mode-template` | `agents-skills` | `swiss-creative-mode-template` | \| |
| `taste-skill` | `agents-skills` | `taste-skill` | \| |
| `template-skill` | `agents-skills` | `template-skill` | Replace with description of the skill and when Claude should use it. |
| `wpds` | `agents-skills` | `wpds` | \| |
| `written-consent` | `agents-skills` | `written-consent` | > |
| `ima-skill` | `codex-skills` | `ima-skill` | \| |

## 6. 重名 / 多来源提醒

以下顶层 skill 名称在多个来源或路径中重复。安装时不要盲目覆盖，先比较来源和版本。

| 名称 | 位置 |
|---|---|
| `baoyu-cover-image` | `codex-skills/baoyu-cover-image`; `agents-skills/baoyu-cover-image` |
| `baoyu-infographic` | `codex-skills/baoyu-infographic`; `agents-skills/baoyu-infographic` |
| `baoyu-markdown-to-html` | `codex-skills/baoyu-markdown-to-html`; `agents-skills/baoyu-markdown-to-html` |
| `baoyu-translate` | `codex-skills/baoyu-translate`; `agents-skills/baoyu-translate` |
| `frontend-design` | `codex-skills/frontend-design`; `agents-skills/frontend-design` |
| `gstack` | `codex-skills/gstack`; `agents-skills/gstack` |
| `ui-ux-pro-max` | `codex-skills/ui-ux-pro-max`; `agents-skills/ui-ux-pro-max` |
| `wechat-official-account-publisher` | `codex-skills/wechat-official-account-publisher`; `agents-skills/wechat-official-account-publisher` |

## 7. 嵌套 / 子技能说明

顶层包内还有大量嵌套 `SKILL.md`，多见于 `gstack`、插件缓存、浏览器技能、模板包或子工作流。下面列出有嵌套 skill 的父目录，供接收方定位。

| 父目录 | 子技能数 | 示例 |
|---|---:|---|
| `codex-skills/gstack` | 464 | `gstack/.agents/skills/gstack`, `gstack/.agents/skills/gstack-autoplan`, `gstack/.agents/skills/gstack-benchmark`, `gstack/.agents/skills/gstack-benchmark-models`, `gstack/.agents/skills/gstack-browse`, `gstack/.agents/skills/gstack-canary`, ... |
| `agents-skills/gstack` | 57 | `gstack/autoplan`, `gstack/benchmark`, `gstack/benchmark-models`, `gstack/browse`, `gstack/browser-skills/hackernews-frontpage`, `gstack/canary`, ... |
| `codex-skills/.system` | 5 | `.system/imagegen`, `.system/openai-docs`, `.system/plugin-creator`, `.system/skill-creator`, `.system/skill-installer` |
| `codex-skills/ima-skill` | 2 | `ima-skill/knowledge-base`, `ima-skill/notes` |

## 8. 全部 `SKILL.md` 索引

这个索引覆盖包中的所有层级，便于 Claude 按路径检索。嵌套索引不作强分类，避免把重复分发的子技能误读为独立主类。

| 名称 | 来源 | 相对路径 | 摘要 |
|---|---|---|---|
| `8-bit-orbit-video-template` | `agents-skills` | `8-bit-orbit-video-template/SKILL.md` | \| |
| `ad-creative` | `agents-skills` | `ad-creative/SKILL.md` | \| |
| `after-hours-editorial-template` | `agents-skills` | `after-hours-editorial-template/SKILL.md` | \| |
| `agent-browser` | `agents-skills` | `agent-browser/SKILL.md` | \| |
| `agently-mail` | `agents-skills` | `agently-mail/SKILL.md` | 通过 agently-cli 命令行工具操作邮件：发送、回复、转发、搜索、读取、下载附件、管理收件箱。当用户需要进行任何邮件相关操作时使用此 skill。 |
| `ai-music-album` | `agents-skills` | `ai-music-album/SKILL.md` | \| |
| `algorithmic-art` | `agents-skills` | `algorithmic-art/SKILL.md` | \| |
| `apple-hig` | `agents-skills` | `apple-hig/SKILL.md` | \| |
| `article-magazine` | `agents-skills` | `article-magazine/SKILL.md` | Huashu / huashu-md-html-inspired magazine article layout for turning Markdown or notes into a polished long-form HTML essay. |
| `artifacts-builder` | `agents-skills` | `artifacts-builder/SKILL.md` | \| |
| `auth-wechat-miniprogram` | `agents-skills` | `auth-wechat-miniprogram/SKILL.md` | CloudBase WeChat Mini Program native authentication guide. This skill should be used when users need mini program identity handling, OPENID/UNIONID access, or `wx.clou... |
| `baoyu-article-illustrator` | `agents-skills` | `baoyu-article-illustrator/SKILL.md` | Analyzes article structure, identifies positions requiring visual aids, generates illustrations with Type × Style × Palette three-dimension approach. Use when user ask... |
| `baoyu-comic` | `agents-skills` | `baoyu-comic/SKILL.md` | Knowledge comic creator supporting multiple art styles and tones. Creates original educational comics with detailed panel layouts and batch-capable image generation. U... |
| `baoyu-compress-image` | `agents-skills` | `baoyu-compress-image/SKILL.md` | Compresses images to WebP (default) or PNG with automatic tool selection. Use when user asks to "compress image", "optimize image", "convert to webp", or reduce image... |
| `baoyu-cover-image` | `agents-skills` | `baoyu-cover-image/SKILL.md` | Generates article cover images with 5 dimensions (type, palette, rendering, text, mood) combining 11 color palettes and 7 rendering styles. Supports cinematic (2.35:1)... |
| `baoyu-danger-gemini-web` | `agents-skills` | `baoyu-danger-gemini-web/SKILL.md` | Generates images and text via reverse-engineered Gemini Web API. Supports text generation, image generation from prompts, reference images for vision input, and multi-... |
| `baoyu-danger-x-to-markdown` | `agents-skills` | `baoyu-danger-x-to-markdown/SKILL.md` | Converts X (Twitter) tweets and articles to markdown with YAML front matter. Uses reverse-engineered API requiring user consent. Use when user mentions "X to markdown"... |
| `baoyu-diagram` | `agents-skills` | `baoyu-diagram/SKILL.md` | Create professional, dark-themed SVG diagrams of any type — architecture diagrams, flowcharts, sequence diagrams, structural diagrams, mind maps, timelines, illustrati... |
| `baoyu-electron-extract` | `agents-skills` | `baoyu-electron-extract/SKILL.md` | Extracts resources and JavaScript from any installed Electron app (`.asar` bundle), restoring original sources from `.js.map` files when available or formatting minifi... |
| `baoyu-format-markdown` | `agents-skills` | `baoyu-format-markdown/SKILL.md` | Formats plain text or markdown files with frontmatter, titles, summaries, headings, bold, lists, and code blocks. Use when user asks to "format markdown", "beautify ar... |
| `baoyu-image-gen` | `agents-skills` | `baoyu-image-gen/SKILL.md` | AI image generation with OpenAI GPT Image 2, Azure OpenAI, Google, OpenRouter, DashScope, Z.AI GLM-Image, MiniMax, Jimeng, Seedream and Replicate APIs. Supports text-t... |
| `baoyu-infographic` | `agents-skills` | `baoyu-infographic/SKILL.md` | Generate professional infographics with 21 layout types and 22 visual styles. Analyzes content, recommends layout×style combinations, and generates publication-ready i... |
| `baoyu-markdown-to-html` | `agents-skills` | `baoyu-markdown-to-html/SKILL.md` | Converts Markdown to styled HTML with WeChat-compatible themes. Supports code highlighting, math, Mermaid (rendered to PNG via headless Chrome), PlantUML, footnotes, a... |
| `baoyu-post-to-wechat` | `agents-skills` | `baoyu-post-to-wechat/SKILL.md` | Posts content to WeChat Official Account (微信公众号) via API or Chrome CDP. Supports article posting (文章) with HTML, markdown, or plain text input, and image-text posting... |
| `baoyu-post-to-weibo` | `agents-skills` | `baoyu-post-to-weibo/SKILL.md` | Posts content to Weibo (微博). Supports regular posts with text, images, and videos, and headline articles (头条文章) with Markdown input via Chrome CDP. Use when user asks... |
| `baoyu-post-to-x` | `agents-skills` | `baoyu-post-to-x/SKILL.md` | Posts content and articles to X (Twitter). Supports regular posts with images/videos and X Articles (long-form Markdown). In Codex, honor explicit requests for the Cod... |
| `baoyu-slide-deck` | `agents-skills` | `baoyu-slide-deck/SKILL.md` | Generates professional slide deck images from content. Creates outlines with style instructions, then generates individual slide images. Use when user asks to "create... |
| `baoyu-translate` | `agents-skills` | `baoyu-translate/SKILL.md` | Translates articles and documents between languages with three modes - quick (direct), normal (analyze then translate), and refined (analyze, translate, review, polish... |
| `baoyu-url-to-markdown` | `agents-skills` | `baoyu-url-to-markdown/SKILL.md` | Fetch any URL and convert to markdown using baoyu-fetch CLI (Chrome CDP with site-specific adapters). Built-in adapters for X/Twitter, YouTube transcripts, Hacker News... |
| `baoyu-wechat-summary` | `agents-skills` | `baoyu-wechat-summary/SKILL.md` | Summarizes WeChat group chat highlights into a structured digest using the local wx-cli binary (https://github.com/jackwener/wx-cli). Generates a normal digest by defa... |
| `baoyu-xhs-images` | `agents-skills` | `baoyu-xhs-images/SKILL.md` | Generates infographic image card series with 12 visual styles, 8 layouts, and 3 color palettes. Breaks content into 1-10 cartoon-style image cards optimized for social... |
| `baoyu-youtube-transcript` | `agents-skills` | `baoyu-youtube-transcript/SKILL.md` | Downloads YouTube video transcripts/subtitles and cover images by URL or video ID. Supports multiple languages, translation, chapters, and speaker identification. Cach... |
| `board-minutes` | `agents-skills` | `board-minutes/SKILL.md` | > |
| `brainstorming` | `agents-skills` | `brainstorming/SKILL.md` | \| |
| `brand-guidelines` | `agents-skills` | `brand-guidelines/SKILL.md` | \| |
| `canvas-design` | `agents-skills` | `canvas-design/SKILL.md` | \| |
| `card-twitter` | `agents-skills` | `card-twitter/SKILL.md` | Twitter quote or data card designed to pair with a post. |
| `card-xiaohongshu` | `agents-skills` | `card-xiaohongshu/SKILL.md` | Xiaohongshu-style knowledge cards, arranged as a swipeable multi-card carousel. |
| `ckm:banner-design` | `agents-skills` | `ckm-banner-design/SKILL.md` | Design banners for social media, ads, website heroes, creative assets, and print. Multiple art direction options with AI-generated visuals. Actions: design, create, ge... |
| `ckm:brand` | `agents-skills` | `ckm-brand/SKILL.md` | Brand voice, visual identity, messaging frameworks, asset management, brand consistency. Activate for branded content, tone of voice, marketing assets, brand complianc... |
| `ckm:design-system` | `agents-skills` | `ckm-design-system/SKILL.md` | Token architecture, component specifications, and slide generation. Three-layer tokens (primitive→semantic→component), CSS variables, spacing/typography scales, compon... |
| `ckm:design` | `agents-skills` | `ckm-design/SKILL.md` | Comprehensive design skill: brand identity, design tokens, UI styling, logo generation (55 styles, Gemini AI), corporate identity program (50 deliverables, CIP mockups... |
| `ckm:slides` | `agents-skills` | `ckm-slides/SKILL.md` | Create strategic HTML presentations with Chart.js, design tokens, responsive layouts, copywriting formulas, and contextual slide strategies. |
| `ckm:ui-styling` | `agents-skills` | `ckm-ui-styling/SKILL.md` | Create beautiful, accessible user interfaces with shadcn/ui components (built on Radix UI + Tailwind), Tailwind CSS utility-first styling, and canvas-based visual desi... |
| `claude-api` | `agents-skills` | `claude-api/SKILL.md` | Build, debug, and optimize Claude API / Anthropic SDK apps. Apps built with this skill should include prompt caching. Also handles migrating existing Claude API code b... |
| `closing-checklist` | `agents-skills` | `closing-checklist/SKILL.md` | > |
| `color-expert` | `agents-skills` | `color-expert/SKILL.md` | \| |
| `competitive-ads-extractor` | `agents-skills` | `competitive-ads-extractor/SKILL.md` | \| |
| `copywriting` | `agents-skills` | `copywriting/SKILL.md` | \| |
| `creative-director` | `agents-skills` | `creative-director/SKILL.md` | \| |
| `d3-visualization` | `agents-skills` | `d3-visualization/SKILL.md` | \| |
| `data-report` | `agents-skills` | `data-report/SKILL.md` | Turns CSV, Excel, or JSON data into a polished visual report page. |
| `deck-guizang-editorial` | `agents-skills` | `deck-guizang-editorial/SKILL.md` | Editorial magazine meets e-ink: 10 layouts and 5 palettes (Ink, Indigo Porcelain, Forest Ink, Kraft Paper, Dune). |
| `deck-open-slide-canvas` | `agents-skills` | `deck-open-slide-canvas/SKILL.md` | Locked 1920x1080 canvas deck with React component-level free composition, not bound to a fixed template. |
| `deck-swiss-international` | `agents-skills` | `deck-swiss-international/SKILL.md` | 16-column grid, one saturated accent, and 22 locked layouts (Klein Blue, Lemon, Mint, Safety Orange). |
| `defuddle` | `agents-skills` | `defuddle/SKILL.md` | Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL... |
| `design-brief` | `agents-skills` | `design-brief/SKILL.md` | \| |
| `design-consultation` | `agents-skills` | `design-consultation/SKILL.md` | \| |
| `design-md` | `agents-skills` | `design-md/SKILL.md` | \| |
| `design-review` | `agents-skills` | `design-review/SKILL.md` | \| |
| `digits-fintech-swiss-template` | `agents-skills` | `digits-fintech-swiss-template/SKILL.md` | \| |
| `diligence-issue-extraction` | `agents-skills` | `diligence-issue-extraction/SKILL.md` | > |
| `doc-coauthoring` | `agents-skills` | `doc-coauthoring/SKILL.md` | Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or sim... |
| `doc-kami-parchment` | `agents-skills` | `doc-kami-parchment/SKILL.md` | Warm parchment canvas (#f5f4ed), monochrome ink-blue accent (#1B365D), one serif family, and editorial-grade typography. |
| `doc` | `agents-skills` | `doc/SKILL.md` | \| |
| `docx` | `agents-skills` | `docx/SKILL.md` | \| |
| `domain-name-brainstormer` | `agents-skills` | `domain-name-brainstormer/SKILL.md` | \| |
| `douyin-video-summary` | `agents-skills` | `douyin-video-summary/SKILL.md` | Summarize Douyin (TikTok China) videos by extracting audio, transcribing with whisper.cpp, and generating structured summaries. Use when a user shares a Douyin link an... |
| `douyin-video` | `agents-skills` | `douyin-video/SKILL.md` | 抖音无水印视频下载和文案提取工具. 从抖音分享链接获取无水印视频下载链接, 下载视频, 提取视频中的语音文案并自动保存到文件. 适用场景包括获取抖音视频信息, 下载无水印视频, 批量提取视频文案. 当用户需要处理抖音视频链接或提取视频内容时触发. |
| `editorial-burgundy-principles-template` | `agents-skills` | `editorial-burgundy-principles-template/SKILL.md` | \| |
| `enhance-prompt` | `agents-skills` | `enhance-prompt/SKILL.md` | \| |
| `fal-3d` | `agents-skills` | `fal-3d/SKILL.md` | \| |
| `fal-generate` | `agents-skills` | `fal-generate/SKILL.md` | \| |
| `fal-image-edit` | `agents-skills` | `fal-image-edit/SKILL.md` | \| |
| `fal-kling-o3` | `agents-skills` | `fal-kling-o3/SKILL.md` | \| |
| `fal-lip-sync` | `agents-skills` | `fal-lip-sync/SKILL.md` | \| |
| `fal-realtime` | `agents-skills` | `fal-realtime/SKILL.md` | \| |
| `fal-restore` | `agents-skills` | `fal-restore/SKILL.md` | \| |
| `fal-train` | `agents-skills` | `fal-train/SKILL.md` | \| |
| `fal-tryon` | `agents-skills` | `fal-tryon/SKILL.md` | \| |
| `fal-upscale` | `agents-skills` | `fal-upscale/SKILL.md` | \| |
| `fal-video-edit` | `agents-skills` | `fal-video-edit/SKILL.md` | \| |
| `fal-vision` | `agents-skills` | `fal-vision/SKILL.md` | \| |
| `faq-page` | `agents-skills` | `faq-page/SKILL.md` | \| |
| `field-notes-editorial-template` | `agents-skills` | `field-notes-editorial-template/SKILL.md` | \| |
| `figma-code-connect-components` | `agents-skills` | `figma-code-connect-components/SKILL.md` | \| |
| `figma-create-design-system-rules` | `agents-skills` | `figma-create-design-system-rules/SKILL.md` | \| |
| `figma-create-new-file` | `agents-skills` | `figma-create-new-file/SKILL.md` | \| |
| `figma-generate-design` | `agents-skills` | `figma-generate-design/SKILL.md` | \| |
| `figma-generate-library` | `agents-skills` | `figma-generate-library/SKILL.md` | \| |
| `figma-implement-design` | `agents-skills` | `figma-implement-design/SKILL.md` | \| |
| `figma-use` | `agents-skills` | `figma-use/SKILL.md` | \| |
| `flutter-animating-apps` | `agents-skills` | `flutter-animating-apps/SKILL.md` | \| |
| `frame-data-chart-nyt` | `agents-skills` | `frame-data-chart-nyt/SKILL.md` | NYT-newsroom typography, staggered reveal animation, and editorial-grade charts (line, bar, or range band). |
| `frame-flowchart-sticky` | `agents-skills` | `frame-flowchart-sticky/SKILL.md` | SVG curve connectors, sticky-note nodes, and cursor interaction with a whiteboard-brainstorm feel. |
| `frame-glitch-title` | `agents-skills` | `frame-glitch-title/SKILL.md` | Digital glitch, chromatic offset, and data-corruption title frame for video transitions or cyberpunk heroes. |
| `frame-light-leak-cinema` | `agents-skills` | `frame-light-leak-cinema/SKILL.md` | Film light leaks, grain, 16:9 letterbox, and large serif type for cinematic openings or chapter cards. |
| `frame-liquid-bg-hero` | `agents-skills` | `frame-liquid-bg-hero/SKILL.md` | WebGL-style fluid displacement background with a quote overlay, suited to video intros, landing heroes, or posters. |
| `frame-logo-outro` | `agents-skills` | `frame-logo-outro/SKILL.md` | Segmented logo assembly, glow bloom, and tagline reveal for video outros or brand closing frames. |
| `frame-macos-notification` | `agents-skills` | `frame-macos-notification/SKILL.md` | Realistic macOS notification banner with app icon, title, and body, suited to video overlays or product teasers. |
| `frontend-design` | `agents-skills` | `frontend-design/SKILL.md` | \| |
| `frontend-dev` | `agents-skills` | `frontend-dev/SKILL.md` | \| |
| `frontend-skill` | `agents-skills` | `frontend-skill/SKILL.md` | \| |
| `frontend-slides` | `agents-skills` | `frontend-slides/SKILL.md` | \| |
| `full-page-screenshot` | `agents-skills` | `full-page-screenshot/SKILL.md` | \| |
| `gif-sticker-maker` | `agents-skills` | `gif-sticker-maker/SKILL.md` | \| |
| `gsap-core` | `agents-skills` | `gsap-core/SKILL.md` | \| |
| `gsap-react` | `agents-skills` | `gsap-react/SKILL.md` | \| |
| `gsap-scrolltrigger` | `agents-skills` | `gsap-scrolltrigger/SKILL.md` | \| |
| `gsap-timeline` | `agents-skills` | `gsap-timeline/SKILL.md` | \| |
| `autoplan` | `agents-skills` | `gstack/autoplan/SKILL.md` | \| |
| `benchmark-models` | `agents-skills` | `gstack/benchmark-models/SKILL.md` | \| |
| `benchmark` | `agents-skills` | `gstack/benchmark/SKILL.md` | \| |
| `browse` | `agents-skills` | `gstack/browse/SKILL.md` | \| |
| `hackernews-frontpage` | `agents-skills` | `gstack/browser-skills/hackernews-frontpage/SKILL.md` | Scrape the Hacker News front page (titles, points, comment counts). |
| `canary` | `agents-skills` | `gstack/canary/SKILL.md` | \| |
| `careful` | `agents-skills` | `gstack/careful/SKILL.md` | \| |
| `codex` | `agents-skills` | `gstack/codex/SKILL.md` | \| |
| `open-gstack-browser` | `agents-skills` | `gstack/connect-chrome/SKILL.md` | \| |
| `context-restore` | `agents-skills` | `gstack/context-restore/SKILL.md` | \| |
| `context-save` | `agents-skills` | `gstack/context-save/SKILL.md` | \| |
| `cso` | `agents-skills` | `gstack/cso/SKILL.md` | \| |
| `design-consultation` | `agents-skills` | `gstack/design-consultation/SKILL.md` | \| |
| `design-html` | `agents-skills` | `gstack/design-html/SKILL.md` | \| |
| `design-review` | `agents-skills` | `gstack/design-review/SKILL.md` | \| |
| `design-shotgun` | `agents-skills` | `gstack/design-shotgun/SKILL.md` | \| |
| `devex-review` | `agents-skills` | `gstack/devex-review/SKILL.md` | \| |
| `document-generate` | `agents-skills` | `gstack/document-generate/SKILL.md` | \| |
| `document-release` | `agents-skills` | `gstack/document-release/SKILL.md` | \| |
| `freeze` | `agents-skills` | `gstack/freeze/SKILL.md` | \| |
| `gstack-upgrade` | `agents-skills` | `gstack/gstack-upgrade/SKILL.md` | \| |
| `guard` | `agents-skills` | `gstack/guard/SKILL.md` | \| |
| `health` | `agents-skills` | `gstack/health/SKILL.md` | \| |
| `investigate` | `agents-skills` | `gstack/investigate/SKILL.md` | \| |
| `ios-clean` | `agents-skills` | `gstack/ios-clean/SKILL.md` | \| |
| `ios-design-review` | `agents-skills` | `gstack/ios-design-review/SKILL.md` | \| |
| `ios-fix` | `agents-skills` | `gstack/ios-fix/SKILL.md` | \| |
| `ios-qa` | `agents-skills` | `gstack/ios-qa/SKILL.md` | \| |
| `ios-sync` | `agents-skills` | `gstack/ios-sync/SKILL.md` | \| |
| `land-and-deploy` | `agents-skills` | `gstack/land-and-deploy/SKILL.md` | \| |
| `landing-report` | `agents-skills` | `gstack/landing-report/SKILL.md` | \| |
| `learn` | `agents-skills` | `gstack/learn/SKILL.md` | \| |
| `make-pdf` | `agents-skills` | `gstack/make-pdf/SKILL.md` | \| |
| `office-hours` | `agents-skills` | `gstack/office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `agents-skills` | `gstack/open-gstack-browser/SKILL.md` | \| |
| `gstack-openclaw-ceo-review` | `agents-skills` | `gstack/openclaw/skills/gstack-openclaw-ceo-review/SKILL.md` | Use when asked to review a plan, challenge a proposal, run a CEO review, poke holes in an approach, think bigger about scope, or decide whether to expand or reduce the... |
| `gstack-openclaw-investigate` | `agents-skills` | `gstack/openclaw/skills/gstack-openclaw-investigate/SKILL.md` | Use when asked to debug, fix a bug, investigate an error, or do root cause analysis, and when users report errors, stack traces, unexpected behavior, or say something... |
| `gstack-openclaw-office-hours` | `agents-skills` | `gstack/openclaw/skills/gstack-openclaw-office-hours/SKILL.md` | Use when asked to brainstorm, evaluate whether an idea is worth building, run office hours, or think through a new product idea or design direction before any code is... |
| `gstack-openclaw-retro` | `agents-skills` | `gstack/openclaw/skills/gstack-openclaw-retro/SKILL.md` | Weekly engineering retrospective. Analyzes commit history, work patterns, and code quality metrics with persistent history and trend tracking. Team-aware with per-pers... |
| `pair-agent` | `agents-skills` | `gstack/pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `agents-skills` | `gstack/plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `agents-skills` | `gstack/plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `agents-skills` | `gstack/plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `agents-skills` | `gstack/plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `agents-skills` | `gstack/plan-tune/SKILL.md` | \| |
| `qa-only` | `agents-skills` | `gstack/qa-only/SKILL.md` | \| |
| `qa` | `agents-skills` | `gstack/qa/SKILL.md` | \| |
| `retro` | `agents-skills` | `gstack/retro/SKILL.md` | \| |
| `review` | `agents-skills` | `gstack/review/SKILL.md` | \| |
| `scrape` | `agents-skills` | `gstack/scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `agents-skills` | `gstack/setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `agents-skills` | `gstack/setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `agents-skills` | `gstack/setup-gbrain/SKILL.md` | \| |
| `ship` | `agents-skills` | `gstack/ship/SKILL.md` | \| |
| `gstack` | `agents-skills` | `gstack/SKILL.md` | \| |
| `skillify` | `agents-skills` | `gstack/skillify/SKILL.md` | \| |
| `sync-gbrain` | `agents-skills` | `gstack/sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `agents-skills` | `gstack/unfreeze/SKILL.md` | \| |
| `guizang-ppt-skill` | `agents-skills` | `guizang-ppt-skill/SKILL.md` | 生成横向翻页网页 PPT（单 HTML 文件），含 WebGL 背景、章节幕封、数据大字报、图片网格等模板。提供两种风格：① "电子杂志 × 电子墨水"（衬线 + 流体背景 + 暖色） ② "瑞士国际主义"（无衬线 + 网格点阵 + IKB/柠檬黄/柠檬绿/安全橙高亮）。当用户需要制作分享 / 演讲 / 发布会风格的网页 PPT，或... |
| `hand-drawn-diagrams` | `agents-skills` | `hand-drawn-diagrams/SKILL.md` | \| |
| `hatch-pet` | `agents-skills` | `hatch-pet/SKILL.md` | Create, repair, validate, preview, and package Codex-compatible animated pet spritesheets from character art, screenshots, generated images, or visual references. Use... |
| `html-ppt-retro-quarterly-review` | `agents-skills` | `html-ppt-retro-quarterly-review/SKILL.md` | \| |
| `huashu-design` | `agents-skills` | `huashu-design/SKILL.md` | 花叔Design（Huashu-Design）——用HTML做高保真原型、交互Demo、幻灯片、动画、设计变体探索+设计方向顾问+专家评审的一体化设计能力。HTML是工具不是媒介，根据任务embody不同专家（UX设计师/动画师/幻灯片设计师/原型师），避免web design tropes。触发词：做原型、设计Demo、交互原型、... |
| `image-enhancer` | `agents-skills` | `image-enhancer/SKILL.md` | \| |
| `imagegen` | `agents-skills` | `imagegen/SKILL.md` | \| |
| `imagen` | `agents-skills` | `imagen/SKILL.md` | \| |
| `internal-comms` | `agents-skills` | `internal-comms/SKILL.md` | A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked t... |
| `json-canvas` | `agents-skills` | `json-canvas/SKILL.md` | Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections. Use when working with .canvas files, creating visual canvases, mind maps, flowc... |
| `login-flow` | `agents-skills` | `login-flow/SKILL.md` | Mobile login and authentication flow screens |
| `marketing-psychology` | `agents-skills` | `marketing-psychology/SKILL.md` | \| |
| `material-contract-schedule` | `agents-skills` | `material-contract-schedule/SKILL.md` | > |
| `mcp-builder` | `agents-skills` | `mcp-builder/SKILL.md` | Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building... |
| `minimax-docx` | `agents-skills` | `minimax-docx/SKILL.md` | \| |
| `minimax-pdf` | `agents-skills` | `minimax-pdf/SKILL.md` | \| |
| `miniprogram-development` | `agents-skills` | `miniprogram-development/SKILL.md` | WeChat Mini Program development skill for building, debugging, previewing, testing, publishing, and optimizing mini program projects. This skill should be used when us... |
| `mockup-device-3d` | `agents-skills` | `mockup-device-3d/SKILL.md` | Static iPhone and MacBook 3D-style showcase with real HTML embedded on screens, glass-lens refraction, and 360-degree turntable composition. |
| `nanobanana-ppt` | `agents-skills` | `nanobanana-ppt/SKILL.md` | \| |
| `obsidian-bases` | `agents-skills` | `obsidian-bases/SKILL.md` | Create and edit Obsidian Bases (.base files) with views, filters, formulas, and summaries. Use when working with .base files, creating database-like views of notes, or... |
| `obsidian-cli` | `agents-skills` | `obsidian-cli/SKILL.md` | Interact with Obsidian vaults using the Obsidian CLI to read, create, search, and manage notes, tasks, properties, and more. Also supports plugin and theme development... |
| `obsidian-markdown` | `agents-skills` | `obsidian-markdown/SKILL.md` | Create and edit Obsidian Flavored Markdown with wikilinks, embeds, callouts, properties, and other Obsidian-specific syntax. Use when working with .md files in Obsidia... |
| `paywall-upgrade-cro` | `agents-skills` | `paywall-upgrade-cro/SKILL.md` | \| |
| `pdf` | `agents-skills` | `pdf/SKILL.md` | \| |
| `pixelbin-media` | `agents-skills` | `pixelbin-media/SKILL.md` | \| |
| `plan-design-review` | `agents-skills` | `plan-design-review/SKILL.md` | \| |
| `platform-design` | `agents-skills` | `platform-design/SKILL.md` | \| |
| `poster-hero` | `agents-skills` | `poster-hero/SKILL.md` | Vertical poster or Moments-style share image with strong visual impact. |
| `ppt-keynote` | `agents-skills` | `ppt-keynote/SKILL.md` | Apple Keynote-quality slides, one card per screen, with keyboard left/right navigation. |
| `pptx-generator` | `agents-skills` | `pptx-generator/SKILL.md` | \| |
| `pptx-html-fidelity-audit` | `agents-skills` | `pptx-html-fidelity-audit/SKILL.md` | Audit a python-pptx export against its source HTML deck, identify layout/content drift (footer overflow, cropped content, missing italic/em, lost styling, off-rhythm s... |
| `pptx` | `agents-skills` | `pptx/SKILL.md` | \| |
| `release-notes-one-pager` | `agents-skills` | `release-notes-one-pager/SKILL.md` | \| |
| `release-skills` | `agents-skills` | `release-skills/SKILL.md` | Universal release workflow. Auto-detects version files and changelogs. Supports Node.js, Python, Rust, Claude Plugin, GitHub Releases, annotated tags, historical relea... |
| `remotion` | `agents-skills` | `remotion/SKILL.md` | \| |
| `replicate` | `agents-skills` | `replicate/SKILL.md` | \| |
| `resume-modern` | `agents-skills` | `resume-modern/SKILL.md` | Modern minimal resume, single A4 page, ready for print or PDF export. |
| `screenshot` | `agents-skills` | `screenshot/SKILL.md` | \| |
| `screenshots-marketing` | `agents-skills` | `screenshots-marketing/SKILL.md` | \| |
| `shadcn-ui` | `agents-skills` | `shadcn-ui/SKILL.md` | \| |
| `shader-dev` | `agents-skills` | `shader-dev/SKILL.md` | \| |
| `skill-creator` | `agents-skills` | `skill-creator/SKILL.md` | Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing... |
| `slack-gif-creator` | `agents-skills` | `slack-gif-creator/SKILL.md` | \| |
| `slides` | `agents-skills` | `slides/SKILL.md` | \| |
| `social-reddit-card` | `agents-skills` | `social-reddit-card/SKILL.md` | Realistic Reddit post card with vote rail and comment count, suited to video overlays or story sharing. |
| `social-spotify-card` | `agents-skills` | `social-spotify-card/SKILL.md` | Spotify Now Playing-style card with album art, progress bar, and playback controls, suited to video overlays or personal homepages. |
| `social-x-post-card` | `agents-skills` | `social-x-post-card/SKILL.md` | Realistic X post card with engagement metrics (likes, reposts, views), suited to video overlays or shareable image cards. |
| `sora` | `agents-skills` | `sora/SKILL.md` | \| |
| `speech` | `agents-skills` | `speech/SKILL.md` | \| |
| `stitch-loop` | `agents-skills` | `stitch-loop/SKILL.md` | \| |
| `swiftui-design` | `agents-skills` | `swiftui-design/SKILL.md` | \| |
| `swiss-creative-mode-template` | `agents-skills` | `swiss-creative-mode-template/SKILL.md` | \| |
| `swiss-user-research-video-template` | `agents-skills` | `swiss-user-research-video-template/SKILL.md` | \| |
| `taste-skill` | `agents-skills` | `taste-skill/SKILL.md` | \| |
| `template-skill` | `agents-skills` | `template-skill/SKILL.md` | Replace with description of the skill and when Claude should use it. |
| `tencent-channel-community` | `agents-skills` | `tencent-channel-community/SKILL.md` | 腾讯频道社区操作 skill,支持频道管理、内容管理与辅助运营,可用于创建和预览公开/私密频道、查看和修改频道资料、管理频道成员与子频道、搜索频道/帖子/作者并获取分享链接、浏览频道主页或指定版块帖子、查看帖子详情/评论/回复、查看互动消息通知、发帖改帖删帖、评论回复点赞、上传图片/视频/文件素材、内容巡检和频道问答自动回复。涉及腾... |
| `theme-factory` | `agents-skills` | `theme-factory/SKILL.md` | \| |
| `threejs` | `agents-skills` | `threejs/SKILL.md` | \| |
| `ui-skills` | `agents-skills` | `ui-skills/SKILL.md` | \| |
| `ui-ux-pro-max` | `agents-skills` | `ui-ux-pro-max/SKILL.md` | UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types across... |
| `venice-audio-music` | `agents-skills` | `venice-audio-music/SKILL.md` | \| |
| `venice-audio-speech` | `agents-skills` | `venice-audio-speech/SKILL.md` | \| |
| `venice-image-edit` | `agents-skills` | `venice-image-edit/SKILL.md` | \| |
| `venice-image-generate` | `agents-skills` | `venice-image-generate/SKILL.md` | \| |
| `venice-video` | `agents-skills` | `venice-video/SKILL.md` | \| |
| `vfx-text-cursor` | `agents-skills` | `vfx-text-cursor/SKILL.md` | Cursor light trail, chromatic rays, and directional flares for word-by-word quote reveals in video intros. |
| `video-downloader` | `agents-skills` | `video-downloader/SKILL.md` | \| |
| `video-hyperframes` | `agents-skills` | `video-hyperframes/SKILL.md` | Hyperframes / Remotion-compatible continuous frame animation with autoplay support. |
| `web-artifacts-builder` | `agents-skills` | `web-artifacts-builder/SKILL.md` | \| |
| `web-design-guidelines` | `agents-skills` | `web-design-guidelines/SKILL.md` | \| |
| `webapp-testing` | `agents-skills` | `webapp-testing/SKILL.md` | Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser s... |
| `wechat-official-account-publisher` | `agents-skills` | `wechat-official-account-publisher/SKILL.md` | Publish HTML articles into a WeChat Official Account draft box on this Mac. Use when the user asks to push an article to WeChat, upload a draft, publish to a WeChat Of... |
| `weread-year-in-review-video-template` | `agents-skills` | `weread-year-in-review-video-template/SKILL.md` | \| |
| `wpds` | `agents-skills` | `wpds/SKILL.md` | \| |
| `written-consent` | `agents-skills` | `written-consent/SKILL.md` | > |
| `xlsx` | `agents-skills` | `xlsx/SKILL.md` | Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xl... |
| `youtube-clipper` | `agents-skills` | `youtube-clipper/SKILL.md` | \| |
| `imagegen` | `codex-skills` | `.system/imagegen/SKILL.md` | Generate or edit raster images when the task benefits from AI-created bitmap visuals such as photos, illustrations, textures, sprites, mockups, or transparent-backgrou... |
| `openai-docs` | `codex-skills` | `.system/openai-docs/SKILL.md` | Use when the user asks how to build with OpenAI products or APIs, asks about Codex itself or choosing Codex surfaces, needs up-to-date official documentation with cita... |
| `plugin-creator` | `codex-skills` | `.system/plugin-creator/SKILL.md` | Create and scaffold plugin directories for Codex with a required `.codex-plugin/plugin.json`, optional plugin folders/files, valid manifest defaults, and personal-mark... |
| `skill-creator` | `codex-skills` | `.system/skill-creator/SKILL.md` | Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities wi... |
| `skill-installer` | `codex-skills` | `.system/skill-installer/SKILL.md` | Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or in... |
| `baoyu-cover-image` | `codex-skills` | `baoyu-cover-image/SKILL.md` | Generates article cover images with 5 dimensions (type, palette, rendering, text, mood) combining 11 color palettes and 7 rendering styles. Supports cinematic (2.35:1)... |
| `baoyu-image-cards` | `codex-skills` | `baoyu-image-cards/SKILL.md` | Generates infographic image card series with 12 visual styles, 8 layouts, and 3 color palettes. Breaks content into 1-10 cartoon-style image cards optimized for social... |
| `baoyu-infographic` | `codex-skills` | `baoyu-infographic/SKILL.md` | Generate professional infographics with 21 layout types and 22 visual styles. Analyzes content, recommends layout×style combinations, and generates publication-ready i... |
| `baoyu-markdown-to-html` | `codex-skills` | `baoyu-markdown-to-html/SKILL.md` | Converts Markdown to styled HTML with WeChat-compatible themes. Supports code highlighting, math, PlantUML, footnotes, alerts, infographics, and optional bottom citati... |
| `baoyu-translate` | `codex-skills` | `baoyu-translate/SKILL.md` | Translates articles and documents between languages with three modes - quick (direct), normal (analyze then translate), and refined (analyze, translate, review, polish... |
| `dashboard` | `codex-skills` | `dashboard/SKILL.md` | \| |
| `embedded-screenshot-text-editor` | `codex-skills` | `embedded-screenshot-text-editor/SKILL.md` | Edit text inside screenshots embedded in legacy Word .doc files, especially terminal screenshots, network-lab screenshots, Wi-Fi/Phone UI screenshots, and mixed PNG/JP... |
| `figma` | `codex-skills` | `figma/SKILL.md` | Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task... |
| `financial-report-pro` | `codex-skills` | `financial-report-pro/SKILL.md` | Local Codex skill for cross-market financial report and disclosure analysis. Use for Chinese listed-company reports, US SEC EDGAR filings, 10-K, 10-Q, 8-K, DEF 14A, Fo... |
| `find-skills` | `codex-skills` | `find-skills/SKILL.md` | Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest i... |
| `frontend-design` | `codex-skills` | `frontend-design/SKILL.md` | Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters... |
| `autoplan` | `codex-skills` | `gstack/.agents/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.agents/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.agents/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.agents/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.agents/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.agents/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.agents/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.agents/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.agents/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.agents/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.agents/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.agents/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.agents/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.agents/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.agents/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.agents/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.agents/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.agents/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.agents/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.agents/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.agents/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.agents/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.agents/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.agents/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.agents/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.agents/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.agents/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.agents/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.agents/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.agents/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.agents/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.agents/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.agents/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.agents/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.agents/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.agents/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.agents/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.agents/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.agents/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.agents/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.agents/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.agents/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.agents/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.agents/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.agents/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.agents/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.cursor/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.cursor/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.cursor/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.cursor/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.cursor/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.cursor/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.cursor/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.cursor/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.cursor/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.cursor/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.cursor/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.cursor/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.cursor/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.cursor/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.cursor/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.cursor/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.cursor/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.cursor/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.cursor/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.cursor/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.cursor/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.cursor/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.cursor/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.cursor/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.cursor/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.cursor/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.cursor/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.cursor/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.cursor/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.cursor/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.cursor/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.cursor/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.cursor/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.cursor/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.cursor/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.cursor/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.cursor/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.cursor/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.cursor/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.cursor/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.cursor/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.cursor/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.cursor/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.cursor/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.cursor/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.cursor/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.factory/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.factory/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.factory/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.factory/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.factory/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.factory/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.factory/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.factory/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.factory/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.factory/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.factory/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.factory/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.factory/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.factory/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.factory/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.factory/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.factory/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.factory/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.factory/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.factory/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.factory/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.factory/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.factory/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.factory/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.factory/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.factory/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.factory/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.factory/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.factory/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.factory/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.factory/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.factory/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.factory/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.factory/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.factory/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.factory/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.factory/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.factory/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.factory/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.factory/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.factory/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.factory/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.factory/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.factory/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.factory/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.factory/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.gbrain/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.gbrain/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.gbrain/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.gbrain/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.gbrain/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.gbrain/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.gbrain/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.gbrain/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.gbrain/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.gbrain/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.gbrain/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.gbrain/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.gbrain/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.gbrain/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.gbrain/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.gbrain/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.gbrain/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.gbrain/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.gbrain/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.gbrain/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.gbrain/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.gbrain/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.gbrain/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.gbrain/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.gbrain/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.gbrain/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.gbrain/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.gbrain/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.gbrain/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.gbrain/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.gbrain/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.gbrain/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.gbrain/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.gbrain/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.gbrain/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.gbrain/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.gbrain/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.gbrain/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.gbrain/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.gbrain/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.gbrain/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.gbrain/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.gbrain/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.gbrain/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.gbrain/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.gbrain/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.hermes/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.hermes/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.hermes/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.hermes/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.hermes/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.hermes/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.hermes/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.hermes/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.hermes/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.hermes/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.hermes/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.hermes/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.hermes/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.hermes/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.hermes/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.hermes/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.hermes/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.hermes/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.hermes/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.hermes/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.hermes/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.hermes/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.hermes/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.hermes/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.hermes/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.hermes/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.hermes/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.hermes/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.hermes/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.hermes/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.hermes/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.hermes/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.hermes/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.hermes/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.hermes/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.hermes/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.hermes/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.hermes/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.hermes/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.hermes/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.hermes/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.hermes/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.hermes/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.hermes/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.hermes/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.hermes/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.kiro/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.kiro/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.kiro/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.kiro/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.kiro/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.kiro/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.kiro/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.kiro/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.kiro/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.kiro/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.kiro/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.kiro/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.kiro/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.kiro/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.kiro/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.kiro/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.kiro/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.kiro/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.kiro/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.kiro/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.kiro/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.kiro/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.kiro/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.kiro/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.kiro/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.kiro/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.kiro/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.kiro/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.kiro/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.kiro/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.kiro/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.kiro/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.kiro/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.kiro/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.kiro/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.kiro/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.kiro/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.kiro/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.kiro/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.kiro/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.kiro/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.kiro/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.kiro/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.kiro/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.kiro/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.kiro/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.openclaw/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.openclaw/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.openclaw/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.openclaw/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.openclaw/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.openclaw/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.openclaw/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.openclaw/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.openclaw/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.openclaw/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.openclaw/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.openclaw/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.openclaw/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.openclaw/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.openclaw/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.openclaw/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.openclaw/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.openclaw/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.openclaw/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.openclaw/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.openclaw/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.openclaw/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.openclaw/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.openclaw/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.openclaw/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.openclaw/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.openclaw/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.openclaw/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.openclaw/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.openclaw/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.openclaw/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.openclaw/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.openclaw/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.openclaw/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.openclaw/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.openclaw/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.openclaw/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.openclaw/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.openclaw/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.openclaw/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.openclaw/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.openclaw/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.openclaw/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.openclaw/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.openclaw/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.openclaw/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.opencode/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.opencode/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.opencode/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.opencode/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.opencode/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.opencode/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.opencode/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.opencode/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.opencode/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.opencode/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.opencode/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.opencode/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.opencode/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.opencode/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.opencode/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.opencode/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.opencode/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.opencode/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.opencode/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.opencode/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.opencode/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.opencode/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.opencode/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.opencode/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.opencode/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.opencode/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.opencode/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.opencode/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.opencode/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.opencode/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.opencode/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.opencode/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.opencode/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.opencode/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.opencode/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.opencode/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.opencode/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.opencode/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.opencode/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.opencode/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.opencode/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.opencode/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.opencode/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.opencode/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.opencode/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.opencode/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/.slate/skills/gstack-autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/.slate/skills/gstack-benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/.slate/skills/gstack-benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/.slate/skills/gstack-browse/SKILL.md` | \| |
| `canary` | `codex-skills` | `gstack/.slate/skills/gstack-canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/.slate/skills/gstack-careful/SKILL.md` | \| |
| `claude` | `codex-skills` | `gstack/.slate/skills/gstack-claude/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/.slate/skills/gstack-context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/.slate/skills/gstack-context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/.slate/skills/gstack-cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/.slate/skills/gstack-design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/.slate/skills/gstack-design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/.slate/skills/gstack-design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/.slate/skills/gstack-design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/.slate/skills/gstack-devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/.slate/skills/gstack-document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/.slate/skills/gstack-freeze/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/.slate/skills/gstack-guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/.slate/skills/gstack-health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/.slate/skills/gstack-investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/.slate/skills/gstack-land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/.slate/skills/gstack-landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/.slate/skills/gstack-learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/.slate/skills/gstack-make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/.slate/skills/gstack-office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/.slate/skills/gstack-open-gstack-browser/SKILL.md` | \| |
| `pair-agent` | `codex-skills` | `gstack/.slate/skills/gstack-pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/.slate/skills/gstack-plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/.slate/skills/gstack-plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/.slate/skills/gstack-plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/.slate/skills/gstack-plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/.slate/skills/gstack-plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/.slate/skills/gstack-qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/.slate/skills/gstack-qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/.slate/skills/gstack-retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/.slate/skills/gstack-review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/.slate/skills/gstack-scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/.slate/skills/gstack-setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/.slate/skills/gstack-setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/.slate/skills/gstack-setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/.slate/skills/gstack-ship/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/.slate/skills/gstack-skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/.slate/skills/gstack-sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/.slate/skills/gstack-unfreeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/.slate/skills/gstack-upgrade/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/.slate/skills/gstack/SKILL.md` | \| |
| `autoplan` | `codex-skills` | `gstack/autoplan/SKILL.md` | \| |
| `benchmark-models` | `codex-skills` | `gstack/benchmark-models/SKILL.md` | \| |
| `benchmark` | `codex-skills` | `gstack/benchmark/SKILL.md` | \| |
| `browse` | `codex-skills` | `gstack/browse/SKILL.md` | \| |
| `hackernews-frontpage` | `codex-skills` | `gstack/browser-skills/hackernews-frontpage/SKILL.md` | Scrape the Hacker News front page (titles, points, comment counts). |
| `canary` | `codex-skills` | `gstack/canary/SKILL.md` | \| |
| `careful` | `codex-skills` | `gstack/careful/SKILL.md` | \| |
| `codex` | `codex-skills` | `gstack/codex/SKILL.md` | \| |
| `context-restore` | `codex-skills` | `gstack/context-restore/SKILL.md` | \| |
| `context-save` | `codex-skills` | `gstack/context-save/SKILL.md` | \| |
| `cso` | `codex-skills` | `gstack/cso/SKILL.md` | \| |
| `design-consultation` | `codex-skills` | `gstack/design-consultation/SKILL.md` | \| |
| `design-html` | `codex-skills` | `gstack/design-html/SKILL.md` | \| |
| `design-review` | `codex-skills` | `gstack/design-review/SKILL.md` | \| |
| `design-shotgun` | `codex-skills` | `gstack/design-shotgun/SKILL.md` | \| |
| `devex-review` | `codex-skills` | `gstack/devex-review/SKILL.md` | \| |
| `document-release` | `codex-skills` | `gstack/document-release/SKILL.md` | \| |
| `freeze` | `codex-skills` | `gstack/freeze/SKILL.md` | \| |
| `gstack-upgrade` | `codex-skills` | `gstack/gstack-upgrade/SKILL.md` | \| |
| `guard` | `codex-skills` | `gstack/guard/SKILL.md` | \| |
| `health` | `codex-skills` | `gstack/health/SKILL.md` | \| |
| `investigate` | `codex-skills` | `gstack/investigate/SKILL.md` | \| |
| `land-and-deploy` | `codex-skills` | `gstack/land-and-deploy/SKILL.md` | \| |
| `landing-report` | `codex-skills` | `gstack/landing-report/SKILL.md` | \| |
| `learn` | `codex-skills` | `gstack/learn/SKILL.md` | \| |
| `make-pdf` | `codex-skills` | `gstack/make-pdf/SKILL.md` | \| |
| `office-hours` | `codex-skills` | `gstack/office-hours/SKILL.md` | \| |
| `open-gstack-browser` | `codex-skills` | `gstack/open-gstack-browser/SKILL.md` | \| |
| `gstack-openclaw-ceo-review` | `codex-skills` | `gstack/openclaw/skills/gstack-openclaw-ceo-review/SKILL.md` | Use when asked to review a plan, challenge a proposal, run a CEO review, poke holes in an approach, think bigger about scope, or decide whether to expand or reduce the... |
| `gstack-openclaw-investigate` | `codex-skills` | `gstack/openclaw/skills/gstack-openclaw-investigate/SKILL.md` | Use when asked to debug, fix a bug, investigate an error, or do root cause analysis, and when users report errors, stack traces, unexpected behavior, or say something... |
| `gstack-openclaw-office-hours` | `codex-skills` | `gstack/openclaw/skills/gstack-openclaw-office-hours/SKILL.md` | Use when asked to brainstorm, evaluate whether an idea is worth building, run office hours, or think through a new product idea or design direction before any code is... |
| `gstack-openclaw-retro` | `codex-skills` | `gstack/openclaw/skills/gstack-openclaw-retro/SKILL.md` | Weekly engineering retrospective. Analyzes commit history, work patterns, and code quality metrics with persistent history and trend tracking. Team-aware with per-pers... |
| `pair-agent` | `codex-skills` | `gstack/pair-agent/SKILL.md` | \| |
| `plan-ceo-review` | `codex-skills` | `gstack/plan-ceo-review/SKILL.md` | \| |
| `plan-design-review` | `codex-skills` | `gstack/plan-design-review/SKILL.md` | \| |
| `plan-devex-review` | `codex-skills` | `gstack/plan-devex-review/SKILL.md` | \| |
| `plan-eng-review` | `codex-skills` | `gstack/plan-eng-review/SKILL.md` | \| |
| `plan-tune` | `codex-skills` | `gstack/plan-tune/SKILL.md` | \| |
| `qa-only` | `codex-skills` | `gstack/qa-only/SKILL.md` | \| |
| `qa` | `codex-skills` | `gstack/qa/SKILL.md` | \| |
| `retro` | `codex-skills` | `gstack/retro/SKILL.md` | \| |
| `review` | `codex-skills` | `gstack/review/SKILL.md` | \| |
| `scrape` | `codex-skills` | `gstack/scrape/SKILL.md` | \| |
| `setup-browser-cookies` | `codex-skills` | `gstack/setup-browser-cookies/SKILL.md` | \| |
| `setup-deploy` | `codex-skills` | `gstack/setup-deploy/SKILL.md` | \| |
| `setup-gbrain` | `codex-skills` | `gstack/setup-gbrain/SKILL.md` | \| |
| `ship` | `codex-skills` | `gstack/ship/SKILL.md` | \| |
| `gstack` | `codex-skills` | `gstack/SKILL.md` | \| |
| `skillify` | `codex-skills` | `gstack/skillify/SKILL.md` | \| |
| `sync-gbrain` | `codex-skills` | `gstack/sync-gbrain/SKILL.md` | \| |
| `unfreeze` | `codex-skills` | `gstack/unfreeze/SKILL.md` | \| |
| `magazine-web-ppt` | `codex-skills` | `guizang-ppt/SKILL.md` | 生成"电子杂志 × 电子墨水"风格的横向翻页网页 PPT（单 HTML 文件），含 WebGL 流体背景、衬线标题 + 非衬线正文、章节幕封、数据大字报、图片网格等模板。当用户需要制作分享 / 演讲 / 发布会风格的网页 PPT，或提到"杂志风 PPT"、"horizontal swipe deck"、"editorial maga... |
| `knowledge-base` | `codex-skills` | `ima-skill/knowledge-base/SKILL.md` | Knowledge Base (知识库) |
| `notes` | `codex-skills` | `ima-skill/notes/SKILL.md` | Notes (笔记) |
| `ima-skill` | `codex-skills` | `ima-skill/SKILL.md` | \| |
| `person-track-record-research` | `codex-skills` | `person-track-record-research/SKILL.md` | Evidence-first research workflow for evaluating a person's historical viewpoints, predictions, claim accuracy, viewpoint changes, and domain-specific credibility. Use... |
| `receiving-code-review` | `codex-skills` | `receiving-code-review/SKILL.md` | Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor a... |
| `subagent-driven-development` | `codex-skills` | `subagent-driven-development/SKILL.md` | Use when executing implementation plans with independent tasks in the current session |
| `test-driven-development` | `codex-skills` | `test-driven-development/SKILL.md` | Use when implementing any feature or bugfix, before writing implementation code |
| `ui-ux-pro-max` | `codex-skills` | `ui-ux-pro-max/SKILL.md` | UI/UX design intelligence for web and mobile. Includes 50+ styles, 161 color palettes, 57 font pairings, 161 product types, 99 UX guidelines, and 25 chart types across... |
| `using-superpowers` | `codex-skills` | `using-superpowers/SKILL.md` | Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions |
| `verification-before-completion` | `codex-skills` | `verification-before-completion/SKILL.md` | Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before ma... |
| `vibe-coding-workflow` | `codex-skills` | `vibe-coding-workflow/SKILL.md` | Apply the EnzeD vibe-coding workflow to a new or existing game/app project. Use when Codex needs to turn an idea into a game design document or PRD, choose a simple ro... |
| `web-prototype` | `codex-skills` | `web-prototype/SKILL.md` | \| |
| `wechat-official-account-publisher` | `codex-skills` | `wechat-official-account-publisher/SKILL.md` | Publish HTML articles into a WeChat Official Account draft box on this Mac. Use when the user asks to push an article to WeChat, upload a draft, publish to a WeChat Of... |
| `writing-plans` | `codex-skills` | `writing-plans/SKILL.md` | Use when you have a spec or requirements for a multi-step task, before touching code |

## 9. 接收方建议

1. 先校验完整包 SHA256，再解压到临时目录。
2. 不要直接把 `codex-skills/` 和 `agents-skills/` 合并覆盖；先保留来源目录，解决重名冲突后再安装。
3. 如果只需要 Codex 使用，优先检查 `codex-skills/`；如果需要 PromptScript/Agents 生态，检查 `agents-skills/`。
4. 对 `gstack` 这类含二进制和依赖的 skill，不要随意裁剪 `bin/`、`dist/`、`node_modules/` 等目录。
5. 对发布类、邮件类、浏览器类、平台 API 类 skill，使用前先检查认证和账号上下文。
