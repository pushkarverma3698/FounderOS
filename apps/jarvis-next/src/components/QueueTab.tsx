import { useState, useEffect } from 'react';

export interface QueueJob {
  id: string;
  company: string;
  title: string;
  track: string;
  url: string;
  brief_rank: number;
  brief_section: string;
  tailored_cv_s3_key: string | null;
}

export function QueueTab() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchQueue = async () => {
    try {
      const res = await fetch('/api/v1/jobhunt/queue');
      if (res.ok) {
        const data = await res.json();
        setJobs(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchQueue();
    const id = setInterval(fetchQueue, 15000);
    return () => clearInterval(id);
  }, []);

  const handleSkip = async (jobId: string) => {
    try {
      await fetch(`/api/v1/jobhunt/${jobId}/skip`, { method: 'POST' });
      setJobs(jobs.filter(j => j.id !== jobId));
    } catch (e) {
      console.error(e);
    }
  };

  if (loading) {
    return <div className="p-8 text-chrome/50 font-mono text-xs">LOADING QUEUE...</div>;
  }

  return (
    <div className="absolute inset-0 p-8 overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6 relative z-10">
        <header className="flex justify-between items-end border-b border-chrome/10 pb-4 mb-6">
          <div>
            <h2 className="text-xl font-mono text-chrome font-semibold tracking-wider">JOB HUNT QUEUE</h2>
            <div className="text-[11px] font-mono text-chrome/50 tracking-widest uppercase mt-2">
              Review-only view of pending applications
            </div>
          </div>
          <div className="text-xs font-mono text-accent">
            {jobs.length} JOBS PENDING
          </div>
        </header>

        <div className="space-y-2">
          {jobs.length === 0 ? (
            <div className="p-8 border border-chrome/10 bg-void/40 backdrop-blur-md rounded text-center text-chrome/50 font-mono text-sm">
              NO JOBS IN QUEUE
            </div>
          ) : (
            jobs.map(job => (
              <div key={job.id} className="group relative border border-chrome/10 bg-void/40 backdrop-blur-md rounded p-4 hover:border-chrome/30 transition-colors flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold text-chrome">{job.company}</span>
                    <span className="text-xs text-chrome/60">{job.title}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-2 text-[10px] font-mono text-chrome/40">
                    <span>TRACK: {job.track}</span>
                    <span>SECTION: {job.brief_section}</span>
                    <span className={job.tailored_cv_s3_key ? 'text-accent' : 'text-chrome/30'}>
                      CV: {job.tailored_cv_s3_key ? 'READY' : 'PENDING'}
                    </span>
                  </div>
                </div>
                
                <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <a 
                    href={job.url} 
                    target="_blank" 
                    rel="noreferrer"
                    className="px-3 py-1 text-[10px] font-mono text-chrome/70 hover:text-chrome border border-chrome/20 hover:border-chrome/50 rounded transition-colors"
                  >
                    VIEW POSTING
                  </a>
                  <button 
                    onClick={() => handleSkip(job.id)}
                    className="px-3 py-1 text-[10px] font-mono text-red-400 hover:text-red-300 border border-red-500/30 hover:border-red-400/50 rounded transition-colors"
                  >
                    SKIP
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
