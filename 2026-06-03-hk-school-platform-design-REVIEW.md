# HK School Platform Design - Review Report

**Document Reviewed:** `2026-06-03-hk-school-platform-design.md`  
**Review Date:** June 3, 2026  
**Reviewer:** Claude Code (Sonnet 4.6)  
**Architecture Context:** Next.js + PostgreSQL (Full-stack)  
**Scope Context:** MVP = Search + Profiles only

---

## Executive Summary

**Overall Score: 4.7/10** - Document is NOT ready for implementation.

The design document articulates a real problem (fragmented school information in Hong Kong) and proposes a reasonable solution (unified search platform). However, it lacks critical implementation details and contains several scope/timeline inconsistencies that would cause project failure if not addressed pre-development.

**Key Findings:**
- ✅ Problem statement is clear and well-motivated
- ✅ Feature list is comprehensive for long-term vision
- ❌ No quantified success metrics (can't evaluate if MVP worked)
- ❌ Data sourcing strategy is handwaved (critical blocker)
- ❌ MVP vs Phase 1 scope mismatch (3-feature gap)
- ❌ Non-functional requirements almost entirely missing
- ❌ Mobile-first reality ignored (95% HK mobile usage)

**Recommendation:** Conduct 2-3 day pre-implementation spike to:
1. Verify EDB data accessibility (1 day)
2. Define quantified success metrics (4 hours)
3. Reconcile MVP scope vs. Phase 1 scope (2 hours)
4. Add database schema + performance targets (4 hours)

**Estimated rework needed:** 1-2 days to bring document to "implementation-ready" state.

---

## Detailed Findings

### 1. Problem Statement Clarity (Score: 6/10)

**Strengths:**
- Target users clearly defined: Parents of pre-K to grade 12 students in Hong Kong
- Pain point articulated: Fragmented information across EDB, school websites, parent forums
- Desired outcome specified: Unified platform for search, comparison, application tracking

**Critical Gaps:**

1. **Missing quantified pain intensity**
   - Issue: No data on how much time parents waste today
   - Impact: Can't calculate ROI or validate if solution is worth building
   - Fix: Add "Parents spend 20+ hours across 15+ sites researching schools" (validate via parent interviews)

2. **User segments not differentiated**
   - Issue: International parents (IB/British curriculum) have different needs than local parents (DSS/government schools)
   - Impact: Risk building for "average parent" who doesn't exist
   - Fix: Add subsection clarifying:
     ```
     Segment 1: Local parents (Cantonese-speaking, DSS/government schools, 70% of market)
     Segment 2: International parents (English-speaking, IB/British schools, 30% of market)
     MVP focus: Segment 2 (smaller dataset, English-only, higher willingness to pay)
     ```

3. **Decision trigger undefined**
   - Issue: When do parents start school search? (12 months before enrollment? 24 months?)
   - Impact: Affects timing of marketing campaigns and feature prioritization
   - Fix: Add "Parents begin research 18-24 months before enrollment (based on HK school application deadlines)"

4. **Success definition missing**
   - Issue: What does "successful search" mean? Found a school? Applied? Enrolled?
   - Impact: Can't design features that optimize for the right outcome
   - Fix: Define success as "Parent identifies 3-5 schools matching criteria and initiates contact"

**Recommendation:** Expand "Problem Statement" section to include user segments and quantified pain metrics.

---

### 2. Success Criteria (Score: 3/10) ⚠️ CRITICAL

**Strengths:**
- None (section is too vague to evaluate)

**Critical Gaps:**

This is the weakest section of the document. Without quantified success metrics, you cannot:
- Evaluate if the MVP worked
- Decide whether to build Phase 2 or pivot
- Prioritize features based on impact
- Justify continued investment to stakeholders

**Current state:** Vague goals like "streamline school search process" and "help parents make informed decisions"

**Required additions:**

```markdown
## Success Metrics (8-week MVP checkpoint)

### Leading Indicators (Usage)
- 500+ unique parents complete at least 1 search
- 30% save 3+ schools for comparison
- Average 4.5 schools viewed per session
- 20% use advanced filters (fees, curriculum, district)

### Lagging Indicators (Outcome)
- 20% return within 7 days (retention signal)
- Average search-to-saved-school time < 5 minutes
- 15% click through to school website/contact
- NPS > 40 from first 50 users surveyed

### Kill Criteria (Stop/Pivot signals)
- < 100 parents use platform in first 4 weeks post-launch
- < 10% save any schools (indicates search isn't valuable)
- Avg session duration < 2 minutes (bounce signal)
- NPS < 0 (negative sentiment)
```

**Impact of gap:** Without these metrics, you'll ship the MVP, get ambiguous feedback ("it's nice"), and not know whether to invest in Phase 2 or cut losses.

**Recommendation:** Add "Success Metrics" section with leading/lagging indicators and explicit kill criteria.

---

### 3. Scope Definition (Score: 7/10)

**Strengths:**
- Clear Phase 1 vs Phase 2 split
- Feature list is specific and actionable
- Timeline estimate provided (8-12 weeks Phase 1)

**Critical Gaps:**

1. **MVP vs Phase 1 mismatch** ⚠️
   - Issue: User selected "MVP = search + profiles only" but document's Phase 1 includes:
     - Search + profiles
     - Comparison tool
     - Application tracking
     - Basic reviews
   - Impact: 3-feature gap = 6-8 weeks extra build time not accounted for
   - Current doc timeline: 8-12 weeks for Phase 1
   - Actual MVP timeline: 3-4 weeks (search + profiles only)
   - Fix needed: Reconcile scope or update timeline

2. **Data scope undefined**
   - Issue: "All Hong Kong schools" = 1,100 schools. Manual entry = 100+ hours.
   - Impact: Data entry becomes the bottleneck, delays launch by 2-3 months
   - Fix: Limit MVP to 50-100 top schools (international + top DSS), expand in Phase 2

3. **"Basic reviews" is ambiguous**
   - Issue: Could mean:
     - Display-only (scraped from forums) - 2 days work
     - User-submitted (requires auth + moderation) - 2 weeks work
     - Star ratings only (no text) - 3 days work
   - Impact: 10x variance in build time depending on interpretation
   - Fix: Specify exact review implementation or defer to Phase 2

**Proposed scope clarification:**

```markdown
## Revised Phases

### MVP (Week 1-4): Search + Profiles
- Basic school search (name, district, education level)
- School detail pages (static info: address, phone, website, fees, curriculum)
- Bilingual support (English/Traditional Chinese)
- Dataset: 50-100 schools (hand-curated, focus on international + top DSS)
- No user accounts, no reviews, no tracking

### Phase 1.5 (Week 5-8): Add Interactivity
- Comparison tool (side-by-side for up to 3 schools)
- Save schools (browser localStorage, no backend)
- Advanced filters (fee range, curriculum type, religion affiliation)
- Dataset expansion: 200-300 schools

### Phase 2 (Month 3-4): User Accounts + UGC
- User authentication (email/password or social login)
- Application tracking (deadlines, status, documents)
- Review system (user-generated, moderated)
- Full dataset: All 1,100 HK schools
```

**Recommendation:** Update "Project Phases" section to reflect 3-stage rollout (MVP → Phase 1.5 → Phase 2) with explicit feature boundaries.

---

### 4. User Journey & Edge Cases (Score: 5/10)

**Strengths:**
- Happy path is clear: Parent lands → searches → views school → compares → decides
- One edge case documented: "No schools match filters" → show suggestion

**Critical Gaps:**

1. **Mobile-first reality ignored** ⚠️
   - Issue: Hong Kong has 95%+ mobile internet usage. Parents will search on phones (MTR commute, waiting for kids).
   - Impact: Desktop-only design will alienate majority of users
   - Missing: No mention of responsive design, touch interactions, mobile performance
   - Fix: Add "Mobile-First Requirements":
     ```
     - All features must work on 375px screen width (iPhone SE)
     - Touch targets ≥ 44px (Apple HIG compliance)
     - Search filters collapsible on mobile (accordion pattern)
     - School comparison in stacked view (not side-by-side)
     - Map interactions optimized for touch (pinch-zoom, tap markers)
     ```

2. **Bilingual edge cases underspecified**
   - Issue: What happens when parent searches in English but school name is Chinese-only?
     - Example: "True Light Girls' College" vs "真光女書院"
   - Impact: Search failures, frustrated users
   - Missing: Cross-language search strategy, romanization handling
   - Fix: Specify search behavior:
     ```
     - Store both English and Chinese names for all schools
     - Search matches against BOTH name_en and name_zh fields
     - Support romanization variants (e.g., "Jianhua" matches "建華")
     - Show school name in user's selected language, with alternate in parentheses
     ```

3. **Data freshness ignored**
   - Issue: School info changes (fees increase, programs discontinued, principal changes)
   - Impact: Parents make decisions on outdated data, lose trust in platform
   - Missing: Data update strategy, "last updated" indicators
   - Fix: Add to school profiles:
     ```
     - "Last updated: January 2026" timestamp on each school page
     - "Report outdated info" link on profiles (sends email to admin)
     - Quarterly data refresh cycle (manual review of top 100 schools)
     ```

4. **Empty states not specified**
   - Issue: What does a new user see when they land on homepage?
   - Missing:
     - Homepage default state (featured schools? empty search box? popular searches?)
     - Zero search results state (fallback options?)
     - Incomplete school profiles (how to handle missing data?)
   - Fix: Specify all empty states:
     ```
     Homepage: Hero with search box + "Popular searches: International, Primary, Central District"
     Zero results: "No schools found. Try: [broaden filters button] or [view nearby schools]"
     Missing data: "Contact info not available - Visit school website" (with link if available)
     ```

5. **Real user behavior not modeled**
   - Issue: Document assumes parents know exactly what they want
   - Reality: Parents will:
     - Misspell school names ("St. Paul" vs "St. Paul's" vs "Saint Paul")
     - Use vague searches ("good school near me")
     - Compare apples to oranges (primary vs secondary schools)
     - Bookmark 20+ schools "just in case"
   - Fix: Add "Search Quality Improvements":
     ```
     - Fuzzy matching for school names (Levenshtein distance ≤ 2)
     - Auto-suggest during typing (typeahead with school names)
     - Location-based search ("within 3km of Causeway Bay")
     - Comparison validation (warn if comparing different education levels)
     - Saved schools limit (max 10, encourage narrowing down)
     ```

**Recommendation:** Add "User Flows & Error Handling" section documenting primary flow, recovery flows, and all empty/error states.

---

### 5. Technical Architecture (Score: 6/10)

**Strengths:**
- Tech stack specified: Next.js, PostgreSQL, Vercel/Railway
- i18n library selected: react-i18next
- Deployment platform chosen

**Critical Gaps:**

1. **Data pipeline is handwaved** ⚠️ BLOCKER
   - Issue: "Scrape EDB website" - EDB uses JavaScript rendering, no official API documented
   - Impact: If scraping fails, entire project is blocked (no data = no product)
   - Missing: Verification that data is accessible, fallback plan
   - Risk: Could spend 4 weeks building platform, then discover data is inaccessible
   - Fix: **PRE-IMPLEMENTATION SPIKE (1 day)**:
     ```
     Task: Verify EDB data accessibility
     1. Attempt scraping EDB school directory with Puppeteer/Playwright
     2. Check if EDB offers CSV export or hidden API
     3. Contact EDB to inquire about official data access
     4. If all fail: Pivot to manual entry of 50 schools for MVP
     ```

2. **Database schema not specified**
   - Issue: No table structure defined for core entities
   - Impact: Risk of poor data modeling (e.g., can't filter by fee range efficiently)
   - Missing: SQL schema for schools, districts, levels, curricula
   - Fix: Add "Database Schema" section:
     ```sql
     -- Core school entity
     CREATE TABLE schools (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       name_en VARCHAR(255) NOT NULL,
       name_zh VARCHAR(255) NOT NULL,
       district VARCHAR(50) NOT NULL, -- 'Central', 'Wan Chai', etc.
       levels TEXT[] NOT NULL,         -- ['Pre-K', 'Primary', 'Secondary']
       curriculum TEXT[] NOT NULL,     -- ['Local', 'IB', 'British', 'IB-PYP']
       fees_annual_min INTEGER,        -- In HKD
       fees_annual_max INTEGER,
       address_en TEXT,
       address_zh TEXT,
       phone VARCHAR(20),
       email VARCHAR(100),
       website VARCHAR(255),
       latitude DECIMAL(10, 8),
       longitude DECIMAL(11, 8),
       religion VARCHAR(50),           -- 'Catholic', 'Christian', 'None'
       gender_policy VARCHAR(20),      -- 'Co-ed', 'Boys', 'Girls'
       last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
       created_at TIMESTAMP NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMP NOT NULL DEFAULT NOW()
     );

     -- Full-text search index
     CREATE INDEX idx_schools_search ON schools 
     USING GIN (to_tsvector('english', name_en || ' ' || name_zh));

     -- Geospatial index for location-based search
     CREATE INDEX idx_schools_location ON schools 
     USING GIST (ll_to_earth(latitude, longitude));
     ```

3. **Search implementation underspecified**
   - Issue: "PostgreSQL full-text search" mentioned but not detailed
   - Missing:
     - How to rank results? (Alphabetical? Relevance? Popularity?)
     - Fuzzy matching support? (handle typos)
     - Multi-language search? (EN/ZH cross-matching)
   - Fix: Specify search strategy:
     ```
     MVP Search (PostgreSQL native):
     - GIN index on tsvector(name_en || name_zh)
     - Ranking: ts_rank() for relevance, then alphabetical
     - Fuzzy: pg_trgm extension for similarity matching (threshold 0.3)
     - Filters: WHERE clauses on district, levels[], fees range
     
     Phase 2 Migration (if needed):
     - Migrate to Algolia/Meilisearch if search QPS > 10/sec
     - Algolia better for typo tolerance, instant results, faceted search
     ```

4. **SEO strategy missing**
   - Issue: No mention of how Google will discover 1,100 school pages
   - Impact: Organic traffic = 0 if pages aren't crawlable
   - Missing: URL structure, sitemap, metadata, SSR/SSG strategy
   - Fix: Add "SEO Requirements":
     ```
     URL Structure:
     - Homepage: hkschools.com
     - Search: hkschools.com/search?q=central&level=primary
     - School detail: hkschools.com/schools/[slug] (e.g., /schools/st-pauls-college)
     
     Next.js Rendering:
     - School detail pages: Static Site Generation (SSG) - generateStaticParams()
     - Search page: Client-side rendering (CSR) - dynamic filters
     - Homepage: Server-side rendering (SSR) - always fresh
     
     Metadata:
     - Dynamic <title>: "{School Name} - Fees, Curriculum, Contact | HK Schools"
     - Dynamic <meta description>: First 160 chars of school description
     - Open Graph tags for social sharing
     - Canonical URLs to prevent duplicate content
     
     Sitemap:
     - Auto-generate sitemap.xml with all school URLs
     - Submit to Google Search Console
     - Update on each data refresh
     ```

5. **Performance not addressed**
   - Issue: No targets for load time, database queries, image optimization
   - Missing:
     - How to handle 1,000 search results? (pagination? infinite scroll?)
     - Image optimization strategy? (school photos, maps)
     - Bundle size budget?
   - Fix: Add "Performance Requirements" (see Section 7 below)

6. **App Router vs Pages Router not specified**
   - Issue: Next.js has two routing systems; affects architecture significantly
   - Impact: App Router (newer) better for SEO/streaming, Pages Router (older) more stable
   - Recommendation: Use **App Router** (Next.js 15 default):
     ```
     Benefits:
     - React Server Components reduce bundle size
     - Nested layouts reduce code duplication
     - Better streaming/Suspense support
     - generateStaticParams() for SSG is cleaner than getStaticPaths()
     
     Trade-offs:
     - Smaller ecosystem (fewer examples)
     - Some libraries not RSC-compatible yet (check react-i18next)
     ```

**Recommendation:** Add subsections for Database Schema, Search Strategy, SEO Requirements. Run 1-day data accessibility spike before implementation.

---

### 6. Dependencies & Risks (Score: 4/10) ⚠️

**Strengths:**
- Two risks acknowledged: data accuracy, review quality

**Critical Gaps:**

1. **Data sourcing is #1 blocker** (already covered in Section 5)
   - Risk: EDB data may be inaccessible
   - Mitigation: 1-day spike to verify, pivot to manual entry if needed
   - Timeline impact: Could add 4-8 weeks if manual entry required

2. **Bilingual content is a hidden time sink**
   - Risk: Most school websites are Chinese-only. If offering bilingual profiles, someone must translate 1,100 × 500 words = 550,000 words
   - Timeline impact: Professional translation = $0.10/word × 550k = $55k cost OR 200+ hours manual work
   - Mitigation options:
     ```
     Option A: Start English-only for international schools (50 schools), defer local schools
     Option B: Use Google Translate API ($20/1M chars = ~$11 for all schools), accept imperfect quality
     Option C: Crowdsource translations from parent community (Phase 2 feature)
     ```
   - **Recommendation:** Option B for MVP (automated translation acceptable for MVP validation)

3. **Regulatory/legal risk not mentioned** ⚠️
   - Risk: User-generated reviews = potential defamation liability
   - HK context: Hong Kong has strict defamation laws. If parent writes "This school has bullying problems," school could sue platform operator
   - Impact: Legal fees > $50k if sued, even if you win
   - Mitigation:
     ```
     - Defer reviews to Phase 2 (de-risk MVP)
     - When implemented: Require manual approval before publishing
     - Terms of Service with liability waiver
     - Consider anonymous reviews vs. verified reviews (trade-off: authenticity vs. accountability)
     - Review moderation checklist (flag defamatory language, unverified claims)
     ```
   - **Recommendation:** Remove reviews from Phase 1, add to Phase 2 with proper legal review

4. **Competition risk underexplored**
   - Risk: schooland.hk, ParentingHeadline, EDB's own site already exist
   - What if they improve their search before you launch?
   - Mitigation:
     ```
     - Monitor competitors monthly (set Google Alerts)
     - Focus on differentiation: Bilingual UX, comparison tool, cleaner design
     - Speed matters: Ship MVP in 4 weeks, not 12 weeks
     ```

5. **Technical dependency risks**
   - Next.js 15: Stable, but App Router has edge cases (e.g., i18n routing is manual)
   - PostgreSQL hosting: Railway/Supabase/Vercel Postgres all have free tiers, but:
     - Railway: Free tier only 500MB storage (may hit limit with 1,100 schools + images)
     - Supabase: 500MB free, then $25/mo
     - Vercel Postgres: Requires Pro plan ($20/mo)
   - react-i18next: Adds ~50KB to bundle (5-10% of typical Next.js app)
   - Mitigation: Budget $25/mo for database hosting from launch

6. **Operational risks**
   - Data maintenance: Who updates school info quarterly? (10-20 hours/quarter)
   - Customer support: Who answers parent questions? (email? chat?)
   - Infrastructure monitoring: Who gets paged if site goes down?
   - Mitigation: Document operational runbook before launch

**Risk Matrix:**

| Risk | Impact | Likelihood | Mitigation Priority |
|------|--------|-----------|---------------------|
| EDB data inaccessible | High (no product) | Medium | 🔴 Critical - 1-day spike |
| Bilingual translation cost | Medium (delays Phase 1) | High | 🟡 Medium - Use Google Translate |
| Legal liability (reviews) | High (lawsuit) | Low | 🟡 Medium - Defer to Phase 2 |
| Competition improves | Medium (lower adoption) | Medium | 🟢 Low - Monitor monthly |
| Database hosting cost | Low ($25/mo) | High | 🟢 Low - Budget allocation |

**Recommendation:** Add "Risk Mitigation Plan" section with matrix above. Prioritize data accessibility spike before any coding.

---

### 7. Non-Functional Requirements (Score: 2/10) ⚠️ CRITICAL

**Strengths:**
- None (section is absent from document)

**Critical Gaps:**

Without non-functional requirements, you could ship a slow, inaccessible, insecure site and technically meet the spec. This section is mandatory for production-ready software.

**Required additions:**

#### 7.1 Performance Targets

```markdown
## Performance Requirements

### Page Load Time
- First Contentful Paint (FCP): < 1.5s on 4G mobile
- Largest Contentful Paint (LCP): < 2.5s on 4G mobile
- Time to Interactive (TTI): < 3.5s on 4G mobile
- Search results: < 500ms server response time

### Core Web Vitals (Google ranking factor)
- LCP: < 2.5s (Good)
- First Input Delay (FID): < 100ms (Good)
- Cumulative Layout Shift (CLS): < 0.1 (Good)

### Bundle Size Budget
- Initial page load: < 200KB JavaScript (gzipped)
- react-i18next: ~50KB (acceptable)
- Lazy-load school detail pages (code-splitting)

### Database Query Performance
- School search: < 100ms (with indexes)
- School detail: < 50ms (single row lookup)
- Connection pooling: Max 10 connections (Vercel limit)

### Pagination Strategy
- Search results: 20 schools per page (avoid loading 1,100 at once)
- Infinite scroll for mobile (better UX than pagination buttons)

### Image Optimization
- Next.js Image component (automatic optimization)
- School photos: WebP format, max 800px width
- Map tiles: Lazy-load (only when user scrolls to map section)
```

#### 7.2 Accessibility (WCAG 2.1 AA)

```markdown
## Accessibility Requirements

### WCAG 2.1 Level AA Compliance
- Automated testing: axe-core DevTools in CI/CD pipeline (fail build on violations)
- Manual testing: Screen reader testing with NVDA (Windows) / VoiceOver (Mac/iOS)
- Color contrast: Minimum 4.5:1 for normal text, 3:1 for large text
- Focus indicators: Visible keyboard focus for all interactive elements
- Alt text: All school photos must have descriptive alt attributes

### Keyboard Navigation
- Tab order follows visual hierarchy
- Skip-to-content link on every page
- All interactive elements (search, filters, comparison) keyboard-accessible
- No keyboard traps (modals/dropdowns must be escapable)

### Screen Reader Support
- Semantic HTML (proper heading hierarchy h1 → h2 → h3)
- ARIA labels for icon-only buttons (e.g., "Close comparison panel")
- Live regions for search results updating (aria-live="polite")
- Skip links for repetitive navigation

### Mobile Accessibility
- Touch targets ≥ 44×44px (Apple HIG / Android Material)
- Pinch-zoom enabled (no user-scalable=no)
- Orientation support (portrait and landscape)
```

#### 7.3 Security Requirements

```markdown
## Security Requirements

### HTTPS & Transport Security
- HTTPS enforced (301 redirect HTTP → HTTPS)
- HSTS header (max-age=31536000)
- Vercel provides SSL certificates automatically

### SQL Injection Prevention
- Prisma ORM (parameterized queries by default)
- Never concatenate user input into SQL strings
- Input validation on search queries (max 100 chars, alphanumeric + spaces)

### XSS (Cross-Site Scripting) Protection
- Next.js auto-escapes JSX by default
- Sanitize user-generated content if reviews are added (use DOMPurify)
- Content-Security-Policy header (restrict script sources)

### Rate Limiting
- Search API: Max 60 requests/minute per IP (prevent scraping)
- Implement with Vercel Edge Middleware or Upstash Redis
- Return 429 Too Many Requests on limit exceeded

### Data Privacy (PDPO Compliance)
- No personally identifiable information collected in MVP (no user accounts)
- If Phase 2 adds user accounts:
  - Cookie consent banner (Hong Kong PDPO requirements)
  - Privacy policy page
  - Email opt-in for marketing (no pre-checked boxes)

### Authentication (Phase 2)
- NextAuth.js for authentication (industry standard)
- OAuth providers (Google, Facebook) preferred over password
- If password auth: bcrypt hashing (cost factor 12)
```

#### 7.4 Browser & Device Support

```markdown
## Browser & Device Support

### Desktop Browsers (last 2 versions)
- Chrome 120+
- Safari 17+
- Firefox 120+
- Edge 120+

### Mobile Browsers
- iOS Safari 15+ (iOS 15 = Sept 2021, reasonable cutoff)
- Android Chrome 100+
- Samsung Internet 20+

### Device Support
- Responsive design: 320px (iPhone SE) → 1920px (desktop)
- Test breakpoints: 375px, 768px, 1024px, 1440px
- Mobile-first CSS (min-width media queries)

### Browser Feature Requirements
- JavaScript enabled (Next.js requires JS)
- Cookies enabled (for language preference storage)
- localStorage available (for saved schools in MVP)
```

#### 7.5 Monitoring & Observability

```markdown
## Monitoring Requirements

### Error Tracking
- Sentry for client + server error tracking
- Alert on error rate > 1% of requests
- Source maps uploaded for readable stack traces

### Analytics
- Vercel Analytics (built-in, privacy-friendly)
- Track key events:
  - Search performed (with query terms anonymized)
  - School profile viewed
  - Schools compared
  - External link clicks (to school websites)

### Performance Monitoring
- Vercel Speed Insights (Core Web Vitals tracking)
- Alert if LCP > 2.5s on mobile for 7 days
- Weekly Lighthouse CI reports

### Uptime Monitoring
- Vercel built-in (99.99% SLA on Pro plan)
- Optional: UptimeRobot for external monitoring (free tier)
```

**Recommendation:** Add "Non-Functional Requirements" section to design doc with all 5 subsections above. These are not optional for production software.

---

## Summary of Critical Issues

### Immediate Blockers (Must fix before coding)

1. **Data Accessibility Verification** 🔴 CRITICAL
   - Issue: No proof that EDB school data is accessible (scraping/API)
   - Impact: Could build entire platform, then discover no data source exists
   - Action: 1-day spike to verify data access, document findings
   - Outcome: If blocked, pivot to manual entry of 50 schools for MVP

2. **Success Metrics Definition** 🔴 CRITICAL
   - Issue: No quantified metrics to evaluate MVP success
   - Impact: Can't determine if MVP worked or should pivot
   - Action: Define 8-week checkpoint metrics (500 searches, 30% save schools, 20% retention)
   - Outcome: Clear go/no-go criteria for Phase 2 investment

3. **MVP Scope Clarification** 🟡 HIGH
   - Issue: Document says "Phase 1 = search + profiles + comparison + tracking + reviews" but user selected "MVP = search + profiles only"
   - Impact: 3-feature gap = 6-8 weeks timeline discrepancy
   - Action: Update document to reflect 3-stage rollout (MVP → Phase 1.5 → Phase 2)
   - Outcome: Aligned expectations on what ships when

### High-Priority Additions (Required for production)

4. **Database Schema** 🟡 HIGH
   - Issue: No table structure defined for schools, districts, levels
   - Impact: Risk of poor data modeling, inefficient queries
   - Action: Document SQL schema with indexes
   - Outcome: Clear data model before coding

5. **Non-Functional Requirements** 🟡 HIGH
   - Issue: No performance, accessibility, security, or browser support targets
   - Impact: Could ship slow, inaccessible, insecure site and meet spec
   - Action: Add performance targets (LCP < 2.5s), WCAG 2.1 AA, rate limiting, browser support
   - Outcome: Production-ready quality standards

6. **Mobile-First Design** 🟡 HIGH
   - Issue: No mention of responsive design, touch interactions, or mobile performance
   - Impact: Alienates 95% of HK users (mobile-first market)
   - Action: Specify mobile breakpoints, touch targets, responsive patterns
   - Outcome: Mobile UX on par with desktop

### Medium-Priority Improvements (Should add)

7. **Bilingual Content Strategy**
   - Issue: Translation cost underestimated (550k words = $55k or 200 hours)
   - Action: Start with Google Translate API ($11 total), accept imperfect quality for MVP
   - Outcome: Bilingual support without manual translation bottleneck

8. **Risk Mitigation Plan**
   - Issue: Risks identified but no mitigation strategies
   - Action: Add risk matrix with impact/likelihood/mitigation priorities
   - Outcome: Proactive risk management

9. **SEO Requirements**
   - Issue: No URL structure, sitemap, or SSG/SSR strategy
   - Action: Define school URL slugs, sitemap generation, Next.js rendering modes
   - Outcome: Organic discovery via Google search

10. **Edge Case Documentation**
    - Issue: Only happy path documented, no error/empty states
    - Action: Specify zero-results fallback, incomplete data handling, search quality improvements
    - Outcome: Better UX when things don't go perfectly

---

## Recommended Action Plan

### Phase 0: Pre-Implementation (2-3 days)

**Day 1: Data Accessibility Spike**
- [ ] Attempt scraping EDB school directory with Puppeteer
- [ ] Check for EDB CSV export or undocumented API
- [ ] Contact EDB to inquire about official data access
- [ ] Document findings: Is data accessible? What's the extraction method?
- [ ] Decision: If blocked, pivot to manual entry of 50 schools for MVP

**Day 2: Document Updates**
- [ ] Add "Success Metrics" section with 8-week checkpoint targets
- [ ] Add "Database Schema" section with SQL for schools table
- [ ] Add "Non-Functional Requirements" section (performance, accessibility, security)
- [ ] Update "Project Phases" to 3-stage rollout (MVP → 1.5 → 2)
- [ ] Add "Risk Mitigation Plan" with prioritized matrix

**Day 3: Technical Prep**
- [ ] Set up Next.js 15 project with App Router
- [ ] Configure PostgreSQL (Vercel Postgres or Supabase)
- [ ] Set up react-i18next with EN/ZH-TW locales
- [ ] Configure Sentry, Vercel Analytics
- [ ] Document dev environment setup in README

### Phase 1: MVP Implementation (3-4 weeks)

**Week 1: Data Layer + Search**
- [ ] Create database schema and migrations
- [ ] Populate 50-100 schools (manual entry or scraped data)
- [ ] Implement PostgreSQL full-text search with GIN indexes
- [ ] Build search API route with filters (district, level, fees)
- [ ] Add pagination (20 results per page)

**Week 2: School Profiles + i18n**
- [ ] Build school detail page component
- [ ] Generate static pages for all schools (SSG)
- [ ] Implement language switcher (EN ↔ ZH-TW)
- [ ] Add bilingual content (Google Translate API for Chinese)
- [ ] Optimize images with Next.js Image component

**Week 3: UI Polish + Mobile**
- [ ] Responsive design (320px → 1920px)
- [ ] Mobile-first filters (accordion pattern)
- [ ] Touch target optimization (≥ 44px)
- [ ] Empty states (zero results, missing data)
- [ ] Loading skeletons for async content

**Week 4: Quality + Launch Prep**
- [ ] WCAG 2.1 AA audit (axe-core)
- [ ] Lighthouse score > 90 (Performance, Accessibility, SEO)
- [ ] Manual testing on iOS/Android
- [ ] Generate sitemap.xml
- [ ] Deploy to Vercel production
- [ ] Monitor Sentry/Analytics for first week

### Phase 1.5: Interactivity (Weeks 5-8, if MVP succeeds)

**Week 5-6: Comparison Tool**
- [ ] Side-by-side comparison UI (desktop)
- [ ] Stacked comparison (mobile)
- [ ] Save schools to localStorage (no backend)
- [ ] Share comparison via URL

**Week 7-8: Advanced Filters**
- [ ] Fee range slider
- [ ] Curriculum multi-select (Local, IB, British)
- [ ] Religion filter
- [ ] Distance-based search (geospatial query)

### Phase 2: User Accounts (Months 3-4, if Phase 1.5 succeeds)

Defer until MVP/Phase 1.5 validates demand. Includes:
- NextAuth.js authentication
- User dashboard
- Application tracking
- Review system (with legal review + moderation)

---

## Appendix: Full-Stack Architecture Decision

**Context:** User chose Next.js + PostgreSQL over Static + Algolia or No-code approaches.

**Implications:**
- **Build time:** 3-4 weeks (vs. 1-2 weeks for static approach)
- **Operational burden:** Database hosting ($25/mo), backup strategy, security patches
- **Flexibility:** Can add user accounts, tracking, reviews without rewrite
- **SEO:** SSG for school pages = excellent crawlability

**Trade-offs accepted:**
- Slower to market (2x build time) in exchange for evolution flexibility
- Higher operational cost/complexity in exchange for feature richness

**Validation that this was right choice:**
User intends to build Phase 1.5 (comparison) and Phase 2 (tracking/reviews) which require backend/database. Full-stack is the correct foundation for that roadmap.

**Alternative not chosen:** Static + Algolia would have been faster (1-2 weeks) but would require backend migration in Phase 2. User prioritized architectural stability over speed to market.

---

## Review Completion Checklist

### Document Status
- ✅ Problem statement evaluated
- ✅ Success criteria assessed (needs significant improvement)
- ✅ Scope definition reviewed (needs clarification)
- ✅ User journey analyzed (mobile gaps identified)
- ✅ Technical architecture audited (data pipeline blocker found)
- ✅ Dependencies & risks mapped (mitigation plans proposed)
- ✅ Non-functional requirements specified (entirely missing from original doc)

### Critical Actions Before Coding
- 🔴 **1-day data accessibility spike** (MANDATORY)
- 🔴 **Add success metrics section** (MANDATORY)
- 🟡 **Clarify MVP scope** (HIGH PRIORITY)
- 🟡 **Add database schema** (HIGH PRIORITY)
- 🟡 **Add non-functional requirements** (HIGH PRIORITY)

### Estimated Rework Time
- Document updates: 1-2 days
- Data accessibility spike: 1 day
- **Total:** 2-3 days to reach implementation-ready state

### Go/No-Go Recommendation
**Status:** 🟡 CONDITIONAL GO

**Conditions:**
1. Complete data accessibility spike successfully (1 day)
2. Update document with success metrics + schema + non-functional reqs (1 day)
3. User confirms MVP scope = search + profiles only (reconcile with doc)

**If conditions met:** Proceed to implementation with high confidence

**If data spike fails:** Pivot to manual entry of 50 schools (adds 1 week to timeline)

---

## End of Review Report

**Next Steps:**
1. User reviews this report
2. User decides: Update design doc now? Or proceed with current doc + accept risks?
3. If updating: Allocate 2-3 days for document rework
4. If proceeding: Acknowledge data accessibility risk, success metrics gap, and NFR absence
5. Begin Phase 0 (pre-implementation spike) or jump directly to Phase 1 (implementation)

**Questions for User:**
- Do you want to update the design document based on this review?
- Should we run the 1-day data accessibility spike before coding?
- Do you accept the timeline (3-4 weeks for MVP = search + profiles only)?
- Any sections of this review that need clarification?
