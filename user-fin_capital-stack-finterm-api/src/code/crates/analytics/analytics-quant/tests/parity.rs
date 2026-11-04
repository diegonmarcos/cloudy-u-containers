//! Data-driven parity test. Loads `tests/fixtures/parity.json` and dispatches
//! each case through the crate's public functions.

use fincept_analytics_quant as q;
use serde::Deserialize;

#[derive(Deserialize)]
struct Registry {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    #[serde(rename = "fn")]
    func: String,
    args: Vec<serde_json::Value>,
    expected: f64,
    tolerance: f64,
}

fn as_vec(v: &serde_json::Value) -> Vec<f64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_f64().unwrap())
        .collect()
}

fn dispatch(c: &Case) -> f64 {
    match c.func.as_str() {
        "mean" => q::mean(&as_vec(&c.args[0])),
        "stddev" => q::stddev(&as_vec(&c.args[0])),
        "percentile" => q::percentile(&as_vec(&c.args[0]), c.args[1].as_f64().unwrap()).unwrap(),
        "skewness" => q::skewness(&as_vec(&c.args[0])),
        "kurtosis" => q::kurtosis(&as_vec(&c.args[0])),
        other => panic!("unknown fn: {other}"),
    }
}

#[test]
fn parity_matrix_passes() {
    let raw = include_str!("fixtures/parity.json");
    let reg: Registry = serde_json::from_str(raw).expect("parity.json valid");
    let mut failures = Vec::new();
    for c in &reg.cases {
        let got = dispatch(c);
        if (got - c.expected).abs() > c.tolerance {
            failures.push(format!(
                "[{}] got {} expected {} (tol {})",
                c.func, got, c.expected, c.tolerance
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "parity failures:\n{}",
        failures.join("\n")
    );
}
