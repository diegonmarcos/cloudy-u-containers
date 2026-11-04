//! Reinforcement learning scaffolding.
//!
//! Phase 5 establishes the Environment/Agent contract and ships a tabular
//! Q-learning agent + multi-armed bandit environment — enough to validate
//! the design end-to-end. Deep RL (DQN/PPO over candle) lands Phase 5b.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("action {0} out of range (n_actions={1})")]
    InvalidAction(usize, usize),
    #[error("state {0} out of range (n_states={1})")]
    InvalidState(usize, usize),
}

pub type Result<T> = std::result::Result<T, Error>;

/// One step returned by `Environment::step`.
#[derive(Debug, Clone, Copy)]
pub struct StepOutcome {
    pub state: usize,
    pub reward: f64,
    pub done: bool,
}

/// Finite state/action environment. Enough to express: bandits, grid worlds,
/// and discretized market-making games.
pub trait Environment {
    fn n_states(&self) -> usize;
    fn n_actions(&self) -> usize;
    fn reset(&mut self) -> usize;
    fn step(&mut self, action: usize) -> Result<StepOutcome>;
}

// ── Multi-armed bandit (deterministic rewards for testability) ──────────────

/// Stationary multi-armed bandit with fixed per-arm rewards.
/// Single "state 0"; `step(a)` returns the arm's reward and terminates the
/// episode. Classic sanity check: Q-learning should converge to preferring
/// the highest-reward arm.
pub struct BanditEnv {
    arm_rewards: Vec<f64>,
    done: bool,
}

impl BanditEnv {
    #[must_use]
    pub fn new(arm_rewards: Vec<f64>) -> Self {
        Self {
            arm_rewards,
            done: false,
        }
    }
}

impl Environment for BanditEnv {
    fn n_states(&self) -> usize {
        1
    }
    fn n_actions(&self) -> usize {
        self.arm_rewards.len()
    }
    fn reset(&mut self) -> usize {
        self.done = false;
        0
    }
    fn step(&mut self, action: usize) -> Result<StepOutcome> {
        if action >= self.arm_rewards.len() {
            return Err(Error::InvalidAction(action, self.arm_rewards.len()));
        }
        self.done = true;
        Ok(StepOutcome {
            state: 0,
            reward: self.arm_rewards[action],
            done: true,
        })
    }
}

// ── Tabular Q-learning agent ────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct QLearning {
    pub alpha: f64,
    pub gamma: f64,
    /// Exploration ε for epsilon-greedy policy selection.
    pub epsilon: f64,
    /// Deterministic pseudo-random seed (LCG, no external crate needed).
    rng_state: u64,
    q: Vec<Vec<f64>>,
}

impl QLearning {
    #[must_use]
    pub fn new(n_states: usize, n_actions: usize, alpha: f64, gamma: f64, epsilon: f64) -> Self {
        Self::new_with_initial_q(n_states, n_actions, alpha, gamma, epsilon, 0.0)
    }

    /// Optimistic-initialization constructor. Setting `initial_q` above the
    /// expected reward range forces the agent to try every action at least
    /// once before any exploitation kicks in — the standard fix for
    /// "converged to local optimum" failures on multi-armed problems with
    /// tight exploration budgets.
    #[must_use]
    pub fn new_with_initial_q(
        n_states: usize,
        n_actions: usize,
        alpha: f64,
        gamma: f64,
        epsilon: f64,
        initial_q: f64,
    ) -> Self {
        Self {
            alpha,
            gamma,
            epsilon,
            rng_state: 0xC001_CAFE_DEAD_BEEF,
            q: vec![vec![initial_q; n_actions]; n_states],
        }
    }

    pub fn set_seed(&mut self, seed: u64) {
        self.rng_state = seed.wrapping_add(1);
    }

    fn rand(&mut self) -> f64 {
        // Linear congruential (Numerical Recipes constants).
        self.rng_state = self
            .rng_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.rng_state >> 11) as f64 / (1_u64 << 53) as f64
    }

    /// ε-greedy action selection. With probability ε choose a random action;
    /// otherwise the argmax Q-value (ties broken toward lower index).
    pub fn select_action(&mut self, state: usize) -> usize {
        if self.rand() < self.epsilon {
            let a = (self.rand() * self.q[state].len() as f64) as usize;
            return a.min(self.q[state].len() - 1);
        }
        self.argmax(state)
    }

    /// Greedy action (no exploration) — useful for evaluation.
    pub fn greedy(&self, state: usize) -> usize {
        self.argmax(state)
    }

    fn argmax(&self, state: usize) -> usize {
        let row = &self.q[state];
        let mut best = 0;
        for i in 1..row.len() {
            if row[i] > row[best] {
                best = i;
            }
        }
        best
    }

    /// One TD update: Q(s,a) ← Q(s,a) + α [r + γ max_a' Q(s',a') − Q(s,a)]
    pub fn update(&mut self, s: usize, a: usize, r: f64, s_next: usize, done: bool) {
        let future = if done {
            0.0
        } else {
            let nxt = &self.q[s_next];
            nxt.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
        };
        let td_target = r + self.gamma * future;
        let cur = self.q[s][a];
        self.q[s][a] = cur + self.alpha * (td_target - cur);
    }

    /// Read-only view of the Q-table.
    #[must_use]
    pub fn q_table(&self) -> &[Vec<f64>] {
        &self.q
    }
}

/// Convenience: train a `QLearning` agent for `episodes` episodes on any
/// `Environment`. Returns the per-episode reward series.
pub fn train<E: Environment>(agent: &mut QLearning, env: &mut E, episodes: u32) -> Vec<f64> {
    let mut history = Vec::with_capacity(episodes as usize);
    for _ in 0..episodes {
        let mut state = env.reset();
        let mut total = 0.0;
        loop {
            let action = agent.select_action(state);
            let out = env.step(action).expect("valid action");
            agent.update(state, action, out.reward, out.state, out.done);
            total += out.reward;
            state = out.state;
            if out.done {
                break;
            }
        }
        history.push(total);
    }
    history
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bandit_converges_to_best_arm() {
        let mut env = BanditEnv::new(vec![0.1, 0.9, 0.2, 0.5]);
        // Optimistic init Q=1.0 (above max reward) forces full exploration.
        let mut agent = QLearning::new_with_initial_q(1, 4, 0.1, 0.9, 0.1, 1.0);
        agent.set_seed(42);
        train(&mut agent, &mut env, 500);
        assert_eq!(agent.greedy(0), 1, "Q-table: {:?}", agent.q_table());
    }

    #[test]
    fn invalid_action_errors() {
        let mut env = BanditEnv::new(vec![0.1, 0.2]);
        env.reset();
        let err = env.step(5).unwrap_err();
        assert!(matches!(err, Error::InvalidAction(5, 2)));
    }
}
