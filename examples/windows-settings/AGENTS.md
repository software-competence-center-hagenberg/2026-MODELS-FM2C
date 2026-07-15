# AGENTS.md — Windows Settings Configurator

This is the agent instructions file used to generate the `windows-settings/` configurator in this repository.

The original source of this file is `~/VibeSettings/AGENTS.md` (the generic 7-view SPL template used for the standard software targets). The instructions below were used with the prompt template from the repository root README:

```
Follow AGENTS.md. Create a configurator for Windows settings. Here is more information: <Windows settings source data, exported as a settings-style configuration file>.
```

The published artefact in this folder is the static `assets/` build output of the generated React + Vite project, split into per-view bundles (`View1Dashboard`, `View2GroupedWizard`, etc.) produced by code-splitting.

---

# AGENTS.md

## Project Overview

This project reimagines **Software Product Lines (SPLs)** -- the way companies structure their product families. Given a picture or textual description of an existing SPL (think car manufacturer lineups, SaaS tiers, or any product portfolio), the agent produces a **modern, restructured version** that is clearer, more strategic, and better positioned for today's market.

The goal is to take an existing, potentially messy or outdated product lineup and output a clean, well-documented, visually appealing product architecture -- complete with segmentation rationale, feature mapping, and positioning guidance.

## Inputs

The agent will receive one of:

1. **A picture** -- a screenshot, diagram, or photograph of an existing SPL (e.g. a car model matrix, a pricing page, a product portfolio chart). The agent should analyse the visual content and extract product names, tiers, features, and relationships.

2. **Textual description** -- a natural-language or structured description of the current SPL or an INI/config file listing products, variants, shared components, and unique features

Additionally it will receive:

1. **MCP Server** -- Access to a React/Vite MCP server for generating the visual output application.

2. **Target brand voice** -- optional. The user may specify the tone: bold and disruptive, conservative and premium, minimalist and clean, etc. If unspecified, default to a modern, professional tone.

If the input is insufficient, lacking or contains errors that you can clearly identify go into Information Gathering Mode.

## Required Output

A working React + Vite application presenting the **reimagined SPL**. Start with a UVL diagram to draw up which modules are required, which are optional, which are if/else. 
Afterwards create **7 distinct views**, each letting the user **select and deselect modules** from a different strategic or visual angle. Every view must produce or contribute to a configuration state — not just display data. Every view is a complete, standalone implementation -- not a shared component reused 7 times.

A lightweight shared configuration state (via React Context or URL params) should persist selections as the user navigates between views.

It should output a "config" file that could theoretically be used for the installation of the final product. (Helm-chart, docker-compose, shell-application for wasm modules, IaC-Compiler, ...)

## Information Gathering Mode

Do NOT make too many assumptions!

If the input is clearly insufficient to build a model the agent should use a questions/decisions plugin to ask the user for more information. There they should be able to provide more information via documents or simple answers.

## Design Rules

### 1. Use strategic labels, not technical keys

- Bad: `variant_B3_sedan_2024`
- Good: "Mid-size sedan for urban professionals"

Every product name, feature label, and segment identifier must be translated into human-friendly language. Add short helper text or tooltips when the rationale is non-obvious.

### 2. No ambiguous product groupings

Group products and features using the most appropriate visual structure for the data.

### 3. Flag strategic conflicts

When products cannibalise each other, target overlapping segments, or share features that should be differentiated, display an inline strategic note (not a silent inconsistency) explaining the tension and suggesting a resolution path.

## Project Structure

```
/
+-- src/
|   +-- views/
|   |   +-- View1/
|   |   +-- View2/
|   |   +-- View3/
|   |   +-- View4/
|   |   +-- View5/
|   |   +-- View6/
|   |   +-- View7/
|   +-- config/
|   |   +-- schema.uvl       # Parsed SPL data as a UVL tree
|   |   +-- schema.dot       # UVL tree converted into Graphviz (dot file) https://pypi.org/project/uvlparser/
|   |   +-- schema.svg       # UVL tree as svg
|   |   +-- schema.ts        # Parsed SPL data + metadata (labels, segments, shared components, conflicts)
|   +-- components/          # Only truly shared primitives (Warning, Tooltip, FeatureTag, etc.)
|   +-- data/
|   |   +-- extracted.ts     # Raw extracted data from input (picture analysis or text parsing)
|   +-- App.tsx              # Navigation between the 7 views
+-- package.json
+-- vite.config.ts
```

- Each view lives in its own folder and owns its layout, styling, and sub-components.
- The SPL schema (product definitions, feature lists, platform mappings, conflict rules) is defined once in `src/config/` and consumed by all views.
- Extracted input data lives in `src/data/` -- separate from the transformed, strategic schema.

## Tech Stack

- React 19+ with TypeScript
- Vite as the build tool
- **Variation required** across the 7 views: different UI libraries, different CSS approaches, different charting or layout libraries. Do not use the same library for every view.
- Validation: prefer `zod` or equivalent so rules are declared once in the schema.
- Charts/visualisations: choose libraries that fit each view's style (e.g. Recharts for one, D3 for another, custom SVG for a third).

## Commands

```bash
npm install      # install dependencies
npm run dev      # start dev server
npm run build    # production build
npm run lint     # lint
```

## Definition of Done

Before considering the task complete, verify:

- [ ] All 7 views are reachable from the app's main navigation.
- [ ] Every view allows the user to select/deselect modules and contributes to a shared configuration state.
- [ ] Strategic conflicts (cannibalisation, overlap) trigger visible inline notes.
- [ ] The 7 views are visibly and structurally distinct in layout, component choice, and colour palette.
- [ ] The configured software settings can be downloaded and includes the settings that the user set. 
- [ ] `src/config/schema.svg` exists — UVL tree rendered as SVG.
- [ ] `npm run build` succeeds with no errors.
- [ ] `npm run lint` passes.

After everything passes create a README.md containing screenshots and a short description of every view.

## Things to Avoid

- Producing 7 views that are essentially the same layout with different colours or fonts.
- Exposing raw product codes, platform numbers, or INI keys as labels in any visible view.
- Silent strategic inconsistencies -- always call out cannibalisation, gaps, and overlaps with an inline note.
- Hard-blocking product combinations instead of flagging them. The stakeholder decides.
- Duplicating the SPL schema across views -- define it once in `src/config/`.
- Treating every view as a data table -- vary the visualisation approach significantly.
- Unit Tests -- not necessary for this project
- Generating `schema.svg` from the UVL/dot file before declaring the task complete
- DO NOT LOOK INTO ._old_tries/
