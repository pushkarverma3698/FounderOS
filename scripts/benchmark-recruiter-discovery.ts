import fs from 'fs';
import path from 'path';

// Define metrics
const metrics = {
  totalAttempted: 0,
  successfulCompanies: 0,
  captchasOrErrors: 0,
  totalRequests: 0,
  startTime: Date.now(),
  endTime: 0,
};

const DELAY_MIN_MS = 2000;
const DELAY_MAX_MS = 5000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelay() {
  return Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1)) + DELAY_MIN_MS;
}

async function searchDuckDuckGo(companyName: string) {
  metrics.totalRequests++;
  const query = `site:linkedin.com/in "Hiring Manager" OR "Recruiter" "${companyName}" "Netherlands"`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!response.ok) {
      console.warn(`[WARN] HTTP ${response.status} for ${companyName}`);
      metrics.captchasOrErrors++;
      return false;
    }

    const html = await response.text();
    
    // DuckDuckGo shows this when rate limiting or captcha
    if (html.includes('id="captcha"') || html.includes('rate limit')) {
      console.warn(`[WARN] CAPTCHA hit for ${companyName}`);
      metrics.captchasOrErrors++;
      return false;
    }

    // Basic heuristic: check if we found a linkedin URL in the results (DDG URL encodes them)
    if (html.toLowerCase().includes('linkedin.com') && (html.toLowerCase().includes('%2fin') || html.toLowerCase().includes('/in/'))) {
      console.log(`[SUCCESS] Found profiles for: ${companyName}`);
      metrics.successfulCompanies++;
      return true;
    } else {
      console.log(`[MISS] No profiles found for: ${companyName}`);
      return false;
    }

  } catch (err) {
    console.error(`[ERROR] Request failed for ${companyName}`, err);
    metrics.captchasOrErrors++;
    return false;
  }
}

async function runBenchmark() {
  console.log("=== STARTING RECRUITER DISCOVERY BENCHMARK ===");
  const csvPath = path.resolve(process.cwd(), 'docs/strategy/data/ind-sponsors-work.csv');
  const fileContent = fs.readFileSync(csvPath, 'utf8');
  
  // Parse simple CSV, skip header (first 2 lines if line 1 is comment)
  const lines = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  // Skip 'name,kvk'
  const dataLines = lines.slice(1);
  
  const sampleSize = 25; // Keeping it to 25 to run fast and prove the concept without getting a hard IP ban immediately
  console.log(`Loaded ${dataLines.length} companies. Benching first ${sampleSize}...`);

  for (let i = 0; i < sampleSize; i++) {
    const line = dataLines[i];
    const [name, kvk] = line.split(',');
    
    // Ensure name is clean (sometimes contains quotes)
    const cleanName = name ? name.replace(/"/g, '') : '';
    if (!cleanName) continue;
    
    metrics.totalAttempted++;
    await searchDuckDuckGo(cleanName);
    
    const delay = getRandomDelay();
    console.log(`Sleeping for ${delay}ms...`);
    await sleep(delay);
  }

  metrics.endTime = Date.now();
  const totalSeconds = (metrics.endTime - metrics.startTime) / 1000;
  
  console.log("\n=== BENCHMARK RESULTS ===");
  console.log(`Total Attempted: ${metrics.totalAttempted}`);
  console.log(`Successful Hits (>=1 recruiter): ${metrics.successfulCompanies}`);
  console.log(`CAPTCHAs / Errors: ${metrics.captchasOrErrors}`);
  console.log(`Total Requests: ${metrics.totalRequests}`);
  console.log(`Total Runtime: ${totalSeconds.toFixed(2)} seconds`);
  console.log(`Avg Seconds / Company: ${(totalSeconds / metrics.totalAttempted).toFixed(2)}s`);
  console.log(`Success Rate: ${((metrics.successfulCompanies / metrics.totalAttempted) * 100).toFixed(1)}%`);
  console.log(`Error Rate: ${((metrics.captchasOrErrors / metrics.totalRequests) * 100).toFixed(1)}%`);
  
  fs.writeFileSync('benchmark-results.json', JSON.stringify({
    ...metrics,
    totalSeconds,
    avgSecondsPerCompany: totalSeconds / metrics.totalAttempted,
    successRate: metrics.successfulCompanies / metrics.totalAttempted,
    errorRate: metrics.captchasOrErrors / metrics.totalRequests
  }, null, 2));
}

runBenchmark().catch(console.error);
