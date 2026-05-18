use libafl::monitors::{
    stats::ClientStatsManager,
    Monitor,
};
use libafl_bolts::{ClientId, Error};
use serde_json::{json, Map, Value};
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

/// A LibAFL monitor that appends one JSON object per display update.
///
/// Copy this file into the generated fuzzer crate and add `serde_json` to
/// `Cargo.toml`:
///
/// ```toml
/// serde_json = "1"
/// ```
///
/// Basic usage with `SimpleEventManager`:
///
/// ```ignore
/// use libafl::events::SimpleEventManager;
/// use std::path::PathBuf;
///
/// let progress_path = PathBuf::from(&task_dir).join("fuzz-progress.jsonl");
/// let monitor = JSONLPrintingMonitor::new(progress_path)?;
/// let mut mgr = SimpleEventManager::new(monitor);
/// ```
///
/// To keep stdout output as well, combine monitors with a tuple:
///
/// ```ignore
/// use libafl::monitors::SimplePrintingMonitor;
///
/// let jsonl_monitor = JSONLPrintingMonitor::new(progress_path)?;
/// let stdout_monitor = SimplePrintingMonitor::new();
/// let mut mgr = SimpleEventManager::new((stdout_monitor, jsonl_monitor));
/// ```
///
/// For restarting or multi-process managers, pass this monitor anywhere a
/// LibAFL `Monitor` is accepted.
#[derive(Debug)]
pub struct JSONLPrintingMonitor {
    file: BufWriter<File>,
}

impl JSONLPrintingMonitor {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, Error> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|err| Error::os_error(err, "failed to open fuzz progress jsonl"))?;

        Ok(Self {
            file: BufWriter::new(file),
        })
    }
}

impl Monitor for JSONLPrintingMonitor {
    fn display(
        &mut self,
        client_stats_manager: &mut ClientStatsManager,
        event_msg: &str,
        sender_id: ClientId,
    ) -> Result<(), Error> {
        client_stats_manager.client_stats_insert(sender_id)?;

        let user_stats = client_stats_manager
            .client_stats_for(sender_id)?
            .user_stats()
            .iter()
            .map(|(key, value)| (key.to_string(), Value::String(value.to_string())))
            .collect::<Map<String, Value>>();

        let edge_coverage = client_stats_manager.edges_coverage();
        let (edges_hit, edges_total, edge_coverage_percent) =
            if let Some(coverage) = edge_coverage {
                let percent = if coverage.edges_total == 0 {
                    None
                } else {
                    Some((coverage.edges_hit as f64 * 100.0) / coverage.edges_total as f64)
                };
                (
                    Some(coverage.edges_hit),
                    Some(coverage.edges_total),
                    percent,
                )
            } else {
                (None, None, None)
            };

        let global_stats = client_stats_manager.global_stats();
        let record = json!({
            "timestamp": unix_timestamp_millis(),
            "eventMsg": event_msg,
            "senderId": sender_id.0,
            "runTimeMs": global_stats.run_time.as_millis(),
            "runTimePretty": global_stats.run_time_pretty.as_str(),
            "clientCount": global_stats.client_stats_count,
            "corpusSize": global_stats.corpus_size,
            "objectiveSize": global_stats.objective_size,
            "totalExecs": global_stats.total_execs,
            "execsPerSec": global_stats.execs_per_sec,
            "execsPerSecPretty": global_stats.execs_per_sec_pretty.as_str(),
            "edgesHit": edges_hit,
            "edgesTotal": edges_total,
            "edgeCoveragePercent": edge_coverage_percent,
            "userStats": user_stats,
        });

        writeln!(self.file, "{record}")
            .map_err(|err| Error::os_error(err, "failed to write fuzz progress jsonl"))?;
        self.file
            .flush()
            .map_err(|err| Error::os_error(err, "failed to flush fuzz progress jsonl"))?;
        Ok(())
    }
}

fn unix_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}
