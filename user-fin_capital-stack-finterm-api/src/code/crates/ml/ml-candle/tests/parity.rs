use fincept_ml_candle as m;
use ndarray::{Array1, Array2};
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

fn as_2d(v: &serde_json::Value) -> Array2<f64> {
    let rows = v.as_array().unwrap();
    let nrows = rows.len();
    let ncols = rows[0].as_array().unwrap().len();
    let mut x = Array2::<f64>::zeros((nrows, ncols));
    for (i, r) in rows.iter().enumerate() {
        for (j, c) in r.as_array().unwrap().iter().enumerate() {
            x[[i, j]] = c.as_f64().unwrap();
        }
    }
    x
}
fn as_1d(v: &serde_json::Value) -> Array1<f64> {
    Array1::from(
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_f64().unwrap())
            .collect::<Vec<_>>(),
    )
}

fn dispatch(c: &Case) -> f64 {
    match c.func.as_str() {
        "ols_slope" => m::ols_fit(&as_2d(&c.args[0]), &as_1d(&c.args[1])).unwrap()[1],
        "ols_intercept" => m::ols_fit(&as_2d(&c.args[0]), &as_1d(&c.args[1])).unwrap()[0],
        "standardize_mean" => {
            let mut x = as_2d(&c.args[0]);
            m::standardize(&mut x);
            // After standardize every column has mean 0 → mean of col-means = 0.
            let col_means: Vec<f64> = x
                .columns()
                .into_iter()
                .map(|c| c.sum() / c.len() as f64)
                .collect();
            col_means.iter().sum::<f64>() / col_means.len() as f64
        }
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
