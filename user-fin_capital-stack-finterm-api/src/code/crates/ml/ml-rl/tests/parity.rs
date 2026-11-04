use fincept_ml_rl::{train, BanditEnv, QLearning};
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
        "bandit_best_arm" => {
            let arms = as_vec(&c.args[0]);
            let episodes = c.args[1].as_u64().unwrap() as u32;
            let seed = c.args[2].as_u64().unwrap();
            let mut env = BanditEnv::new(arms);
            // Optimistic init (Q=1.0) forces full exploration in tight budgets.
            let mut agent = QLearning::new_with_initial_q(1, env.n_actions(), 0.1, 0.9, 0.1, 1.0);
            agent.set_seed(seed);
            train(&mut agent, &mut env, episodes);
            agent.greedy(0) as f64
        }
        other => panic!("unknown fn: {other}"),
    }
}

use fincept_ml_rl::Environment;

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
