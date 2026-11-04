use fincept_analytics_portfolio as p;
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
fn num(v: &serde_json::Value) -> f64 {
    v.as_f64().unwrap()
}

fn dispatch(c: &Case) -> f64 {
    match c.func.as_str() {
        "portfolio_return" => {
            p::portfolio_return(&as_vec(&c.args[0]), &as_vec(&c.args[1])).unwrap()
        }
        "min_variance_two_asset_w1" => {
            p::min_variance_two_asset(num(&c.args[0]), num(&c.args[1]), num(&c.args[2]))
                .unwrap()
                .0
        }
        "portfolio_variance_two" => p::portfolio_variance_two(
            num(&c.args[0]),
            num(&c.args[1]),
            num(&c.args[2]),
            num(&c.args[3]),
            num(&c.args[4]),
        )
        .unwrap(),
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
