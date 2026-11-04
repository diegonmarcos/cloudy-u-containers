use fincept_analytics_fixedincome as f;
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

fn num(v: &serde_json::Value) -> f64 {
    v.as_f64().unwrap()
}

fn dispatch(c: &Case) -> f64 {
    let a = &c.args;
    match c.func.as_str() {
        "bond_price" => f::bond_price(
            num(&a[0]),
            num(&a[1]),
            num(&a[2]),
            num(&a[3]),
            num(&a[4]) as u32,
        )
        .unwrap(),
        "macaulay_duration" => f::macaulay_duration(
            num(&a[0]),
            num(&a[1]),
            num(&a[2]),
            num(&a[3]),
            num(&a[4]) as u32,
        )
        .unwrap(),
        "modified_duration" => f::modified_duration(
            num(&a[0]),
            num(&a[1]),
            num(&a[2]),
            num(&a[3]),
            num(&a[4]) as u32,
        )
        .unwrap(),
        "convexity" => f::convexity(
            num(&a[0]),
            num(&a[1]),
            num(&a[2]),
            num(&a[3]),
            num(&a[4]) as u32,
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
